#!/usr/bin/env bash
# Read-only verification of the already merged, deployed, zero-skip regression and the live
# singleton watchdog binding. It performs no merge, deployment, binding, heartbeat, or task write.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-deployment-attestation.mjs" watchdog-current-binding
