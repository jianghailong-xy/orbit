#!/usr/bin/env bash
# Read-only current-target integration acceptance. The isolated auto-dispatch matrix must have
# run first; this binds it to the exact pushed and deployed target plus its merge receipt.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-deployment-attestation.mjs" auto-dispatch
