#!/usr/bin/env bash
# P1a acceptance: fresh builds and every named routing and permission regression must run and pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
npm run build -w @orbit/shared
rm -rf src/apiserver/build
./node_modules/.bin/tsc -p src/apiserver/tsconfig.test.json
node scripts/test-dsh-routing.mjs
