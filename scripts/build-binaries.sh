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

# suffix:GOOS:GOARCH
TARGETS=(
  "linux-x64:linux:amd64"
  "linux-arm64:linux:arm64"
  "darwin-x64:darwin:amd64"
  "darwin-arm64:darwin:arm64"
)

# Bake the deployment's public origin into the binary's defaultServer so a self-hosted
# runner's `orbit register` connects there with no --server. Unset → keep the source default.
LDFLAGS="-s -w -X main.version=$VER"
if [ -n "${PUBLIC_ORIGIN:-}" ]; then
  LDFLAGS="$LDFLAGS -X main.defaultServer=$PUBLIC_ORIGIN"
fi

mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do
  suffix="${t%%:*}"
  rest="${t#*:}"
  goos="${rest%%:*}"
  goarch="${rest##*:}"
  echo ">> orbit-$suffix ($goos/$goarch) v$VER"
  (cd "$SRC" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$ROOT/$OUT/orbit-$suffix" .)
  # Ship the binary gzip-compressed; -f replaces orbit-$suffix with orbit-$suffix.gz.
  gzip -9 -f "$ROOT/$OUT/orbit-$suffix"
done

printf '{"version":"%s"}\n' "$VER" > "$OUT/version.json"
echo ">> wrote $OUT/version.json (v$VER)"
ls -lh "$OUT"
