#!/usr/bin/env bash
# P3b: every named dsh session lifecycle scenario, its race run and the real pinned dsh scenario must pass.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-session-lifecycle.mjs "$@"
