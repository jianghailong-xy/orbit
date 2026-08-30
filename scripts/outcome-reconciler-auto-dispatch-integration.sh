#!/usr/bin/env bash
# Read-only target integration acceptance. In the Release DAG it binds the completed regression to
# the pushed target and merge receipt, then emits a typed deployment deferral. Standalone use keeps
# the post-deployment/current-binding assertions.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-deployment-attestation.mjs" auto-dispatch
