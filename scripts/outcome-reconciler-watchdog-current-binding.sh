#!/usr/bin/env bash
# Read-only verification of the zero-skip regression. In the Release DAG it binds predeploy
# evidence and defers the live singleton assertion; standalone use verifies the deployed binding.
# It performs no merge, deployment, binding, heartbeat, or task write.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-deployment-attestation.mjs" watchdog-current-binding
