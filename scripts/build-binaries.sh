#!/usr/bin/env bash
# Build standalone `orbit` runner binaries (Go, static, no runtime needed) for
# each OS/arch, plus the version.json manifest the runner self-update checks.
#
# Output (default dist-bin/):
#   orbit-linux-x64  orbit-linux-arm64  orbit-darwin-x64  orbit-darwin-arm64
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

mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do
  suffix="${t%%:*}"
  rest="${t#*:}"
  goos="${rest%%:*}"
  goarch="${rest##*:}"
  echo ">> orbit-$suffix ($goos/$goarch) v$VER"
  (cd "$SRC" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.version=$VER" -o "$ROOT/$OUT/orbit-$suffix" .)
done

printf '{"version":"%s"}\n' "$VER" > "$OUT/version.json"
echo ">> wrote $OUT/version.json (v$VER)"
ls -lh "$OUT"
