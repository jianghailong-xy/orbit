#!/usr/bin/env bash
# Read-only integration acceptance. The implementation phase must already have merged, deployed,
# run the isolated smoke matrix, and generated the attestation consumed here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-auto-dispatch-integration.mjs" verify
