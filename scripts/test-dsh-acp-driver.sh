#!/usr/bin/env bash
# P3a: every named driver scenario, including the pinned real dsh runner, must pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-acp-driver.mjs
