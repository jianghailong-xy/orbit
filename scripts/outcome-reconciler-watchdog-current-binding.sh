#!/usr/bin/env bash
# Unique task acceptance: read-only verification of the already merged, deployed, zero-skip
# regression and production attestation. It deliberately performs no merge, deploy, projection,
# doneGate, Project, Task, binding, heartbeat, or dead-man write.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-watchdog-current-binding-integration.mjs" verify
