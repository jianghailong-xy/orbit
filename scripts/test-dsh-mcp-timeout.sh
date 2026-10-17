#!/usr/bin/env bash
# Orbit MCP calls that wait for the owner, under the pinned dsh's 60-second MCP call deadline: every
# named scenario, its race run and the real pinned dsh scenarios must pass. Missing, unmatched,
# skipped or unstarted tests fail.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-mcp-timeout.mjs "$@"
