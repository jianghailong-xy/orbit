#!/usr/bin/env bash
# P4: every named Orbit MCP, approval and permission-capability scenario, its race run and the
# real pinned dsh scenarios must pass. Missing, unmatched, skipped or unstarted tests fail.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-mcp-approval.mjs "$@"
