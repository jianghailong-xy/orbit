#!/usr/bin/env bash
# Build standalone `orbit` runner binaries (Go, static, no runtime needed) for
# each OS/arch, plus the version.json manifest the runner self-update checks.
#
# Output (default dist-bin/), each runner binary gzip-compressed (~2.4 MB each;
# install.sh and the Go self-updater fetch the .gz and decompress with stdlib gzip):
#   orbit-linux-x64.gz  orbit-linux-arm64.gz  orbit-darwin-x64.gz  orbit-darwin-arm64.gz
#   version.json
#
# Requires: the Go toolchain on PATH.
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

mkdir -p "$OUT"
echo ">> source $SOURCE_SHA"
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
  # Ship the binary gzip-compressed; -f replaces orbit-$suffix with orbit-$suffix.gz.
  gzip -9 -f "$ROOT/$OUT/orbit-$suffix"
done

(cd "$SRC" && go run ./cmd/release-manifest \
  "$VER" "$ROOT/contracts/runner-write-protocol.json" "$ROOT/$OUT/version.json")
echo ">> wrote $OUT/version.json (v$VER)"
ls -lh "$OUT"
