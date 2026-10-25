#!/bin/bash
# On the HPC host: build the managed runner binary of a commit the way the image's first stage does
# (deploy/managed-runner/image/Dockerfile: Go 1.27.1, CGO off, -trimpath, the commit stamped), into
# /mnt/data/tmp/34ilx9dqVOKBeYZObuIjI/work/bin/orbit-<variant>, which the D10 test host sees as /work/bin.
#   binaries.sh <variant> <commit> [repository]
set -euo pipefail
T=/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI
VARIANT="$1"; COMMIT="$2"; FROM="${3:-/root/orbit}"
SHA="$(git -C "$FROM" rev-parse --verify "$COMMIT^{commit}")"
SRC="$T/src/$VARIANT"
rm -rf "$SRC"
mkdir -p "$SRC" "$T/work/bin"
git -C "$FROM" archive "$SHA" src/runner-go | tar -x -C "$SRC"
cd "$SRC/src/runner-go"
test "$(go env GOVERSION)" = go1.27.1
CGO_ENABLED=0 GOTOOLCHAIN=local go build -buildvcs=false -trimpath \
  -ldflags="-s -w -X main.sourceSHA=$SHA -X main.version=managed-$SHA" -o "$T/work/bin/orbit-$VARIANT" .
echo "orbit-$VARIANT: $SHA $(sha256sum "$T/work/bin/orbit-$VARIANT" | cut -c1-16) $(git -C "$FROM" diff --stat "$SHA" HEAD -- src/runner-go 2>/dev/null | tail -n 1)"
