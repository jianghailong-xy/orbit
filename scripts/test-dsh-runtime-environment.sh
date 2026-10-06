#!/usr/bin/env bash
# P2 acceptance: every named installation, isolation and credential scenario must pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
npm run build -w @orbit/shared
rm -rf src/apiserver/build
./node_modules/.bin/tsc -p src/apiserver/tsconfig.test.json
node scripts/test-dsh-runtime-environment.mjs
