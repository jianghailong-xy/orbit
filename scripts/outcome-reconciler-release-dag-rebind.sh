#!/usr/bin/env bash
# Compatibility name for the current focused Release DAG target rebind.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$REPO/scripts/outcome-reconciler-release-dag-pcc-rebind.sh"
