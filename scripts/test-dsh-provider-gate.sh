#!/usr/bin/env bash
# P1b acceptance: real PostgreSQL and every named runner capability scenario must pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-provider-gate.mjs
