#!/usr/bin/env bash
# Build standalone `orbit` runner binaries (Go, static, no runtime needed) for
# each OS/arch, plus the version.json manifest the runner self-update checks.
#
# Output (default dist-bin/), each runner binary gzip-compressed (~2.4 MB each;
# install.sh and the Go self-updater fetch the .gz and decompress with stdlib gzip):
#   orbit-linux-x64.gz  orbit-linux-arm64.gz  orbit-darwin-x64.gz  orbit-darwin-arm64.gz
#   version.json  (names each .gz with the sha256 of its bytes as served: assets.<platform>)
# With ORBIT_MACOS_SIGNING_P12 set, the two darwin binaries are signed with that Developer ID
# before they are compressed, so version.json vouches for the signed bytes (see below).
#
# Requires: the Go toolchain on PATH, and rcodesign (apple-codesign) when signing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="${1:-dist-bin}"
SRC="src/runner-go"
# Version of record: the root package.json.
VER="$(grep -m1 '"version"' package.json | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
# What `git rev-parse HEAD` reads, read straight from the files. Docker's runner-binary
# stage gets `.git/HEAD` and the refs but no object store (see .dockerignore), so `git`
# refuses the tree there while the commit itself is still sitting in plain sight.
resolve_head_from_files() {
  local head ref
  head="$(cat .git/HEAD 2>/dev/null)" || return 1
  case "$head" in
    "ref: "*)
      ref="${head#ref: }"
      if [ -f ".git/$ref" ]; then
        cat ".git/$ref"
      else
        awk -v ref="$ref" '$2 == ref { print $1; hit = 1 } END { exit !hit }' .git/packed-refs 2>/dev/null
      fi
      ;;
    *) printf '%s\n' "$head" ;;
  esac
}

# Deployments may inject the exact checked-out commit; otherwise the tree names itself.
# Never publish an anonymous or malformed capability revision.
SOURCE_SHA="${ORBIT_SOURCE_SHA:-}"
if [ -z "$SOURCE_SHA" ]; then
  SOURCE_SHA="$(git rev-parse HEAD 2>/dev/null || resolve_head_from_files || true)"
fi
if [ -z "$SOURCE_SHA" ]; then
  echo "error: no Git metadata in the build context to name the source commit" >&2
  echo '       build from a Git clone, or name the commit explicitly:' >&2
  echo '       ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" docker compose up -d --build' >&2
  exit 1
fi
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: ORBIT_SOURCE_SHA must be a full lowercase 40-character Git SHA" >&2
  exit 1
fi

# suffix:GOOS:GOARCH
TARGETS=(
  "linux-x64:linux:amd64"
  "linux-arm64:linux:arm64"
  "darwin-x64:darwin:amd64"
  "darwin-arm64:darwin:arm64"
)

# Bake the deployment's public origin into the binary's defaultServer so a self-hosted
# runner's `orbit register` connects there with no --server. Unset → keep the source default.
LDFLAGS="-s -w -X main.version=$VER -X main.sourceSHA=$SOURCE_SHA"
if [ -n "${PUBLIC_ORIGIN:-}" ]; then
  LDFLAGS="$LDFLAGS -X main.defaultServer=$PUBLIC_ORIGIN"
fi

# A Developer ID signature for the darwin binaries (docs/release-process.md, "macOS runner
# signature"). The Go linker signs a darwin binary ad hoc, as "a.out", and macOS files a user's
# privacy (TCC) answers for such a binary under its code hash, which every release changes: each
# update asked for Documents, Desktop and the rest all over again. Signed under one identifier by
# one team, every release meets the same designated requirement, and the answers carry over.
# ORBIT_MACOS_SIGNING_P12 names the identity's .p12 and ORBIT_MACOS_SIGNING_PASSWORD_FILE a file
# whose first line is its password; nothing here prints either. Unset, nothing is signed.
MACOS_SIGNING_P12="${ORBIT_MACOS_SIGNING_P12:-}"
MACOS_SIGNING_PASSWORD_FILE="${ORBIT_MACOS_SIGNING_PASSWORD_FILE:-}"
MACOS_IDENTIFIER="com.orbit.runner"
if [ -n "$MACOS_SIGNING_P12" ]; then
  if [ ! -s "$MACOS_SIGNING_P12" ] || [ ! -s "$MACOS_SIGNING_PASSWORD_FILE" ]; then
    echo "error: ORBIT_MACOS_SIGNING_P12 and ORBIT_MACOS_SIGNING_PASSWORD_FILE must name the" >&2
    echo "       Developer ID .p12 and a file holding its password" >&2
    exit 1
  fi
  if ! command -v rcodesign >/dev/null 2>&1; then
    echo "error: signing the macOS binaries needs rcodesign (apple-codesign) on PATH" >&2
    exit 1
  fi
  # The hardened runtime, with the entitlements that keep its prompts. macOS asks on the runner's
  # behalf for what the tools an agent runs reach for, and a hardened process without the matching
  # entitlement is refused the camera, microphone, location, contacts, calendars, photos and Apple
  # Events outright, the user never asked. Files and folders need no entitlement.
  MACOS_ENTITLEMENTS="$(mktemp)"
  trap 'rm -f "$MACOS_ENTITLEMENTS"' EXIT
  cat >"$MACOS_ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.automation.apple-events</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.personal-information.addressbook</key><true/>
  <key>com.apple.security.personal-information.calendars</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
  <key>com.apple.security.personal-information.photos-library</key><true/>
</dict>
</plist>
PLIST
fi

# sign_macos signs one darwin binary in place, then reads back the identifier it now carries.
# rcodesign's own output is shown only when it fails.
sign_macos() {
  local bin="$1" log info identifier team
  log="$(mktemp)"
  if ! rcodesign sign --p12-file "$MACOS_SIGNING_P12" --p12-password-file "$MACOS_SIGNING_PASSWORD_FILE" \
      --binary-identifier "$MACOS_IDENTIFIER" --code-signature-flags runtime \
      --entitlements-xml-file "$MACOS_ENTITLEMENTS" "$bin" >"$log" 2>&1; then
    cat "$log" >&2
    echo "error: could not sign $(basename "$bin")" >&2
    # rcodesign reports a .p12 it cannot decrypt as a wrong password.
    if grep -q 'PFX' "$log"; then
      echo "       If the password is right, rcodesign cannot read this .p12's encryption: it reads one" >&2
      echo "       protected with SHA-1 and 3DES or RC2 (docs/release-process.md shows how to rewrite it)" >&2
    fi
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  info="$(rcodesign print-signature-info "$bin")"
  identifier="$(sed -n 's/^ *identifier: //p' <<<"$info")"
  team="$(sed -n 's/^ *team_name: //p' <<<"$info")"
  if [ "$identifier" != "$MACOS_IDENTIFIER" ]; then
    echo "error: $(basename "$bin") came out signed as '$identifier', not $MACOS_IDENTIFIER" >&2
    exit 1
  fi
  # An Apple-issued Developer ID puts its team in the signature; another certificate puts none.
  echo "   signed as $MACOS_IDENTIFIER, team ${team:-none (not an Apple-issued certificate)}"
}

mkdir -p "$OUT"
echo ">> source $SOURCE_SHA"
ASSETS=()
for t in "${TARGETS[@]}"; do
  suffix="${t%%:*}"
  rest="${t#*:}"
  goos="${rest%%:*}"
  goarch="${rest##*:}"
  echo ">> orbit-$suffix ($goos/$goarch) v$VER"
  # -buildvcs=false: the commit is already stamped above, and Go's own VCS stamping fails
  # outright on the metadata-only .git the Docker build stage carries.
  (cd "$SRC" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o "$ROOT/$OUT/orbit-$suffix" .)
  # An unreferenced `-X` target is dropped by the linker without a word, which published
  # anonymous binaries for as long as nothing read main.sourceSHA. Check the stamp landed.
  if ! grep -qa "$SOURCE_SHA" "$ROOT/$OUT/orbit-$suffix"; then
    echo "error: orbit-$suffix carries no source stamp — does anything still read main.sourceSHA?" >&2
    exit 1
  fi
  if [ -n "$MACOS_SIGNING_P12" ] && [ "$goos" = darwin ]; then
    sign_macos "$ROOT/$OUT/orbit-$suffix"
  fi
  # Ship the binary gzip-compressed; -f replaces orbit-$suffix with orbit-$suffix.gz.
  gzip -9 -f "$ROOT/$OUT/orbit-$suffix"
  ASSETS+=("$ROOT/$OUT/orbit-$suffix.gz")
done

# Only the .gz files built above: a stale one left in $OUT must not be vouched for.
(cd "$SRC" && go run ./cmd/release-manifest \
  "$VER" "$ROOT/contracts/runner-write-protocol.json" "$ROOT/$OUT/version.json" "${ASSETS[@]}")
echo ">> wrote $OUT/version.json (v$VER)"
ls -lh "$OUT"
