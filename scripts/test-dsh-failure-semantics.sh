#!/usr/bin/env bash
# D2/F1 acceptance: a real DeepSeek 401 is an invalid key (and nothing vaguer is), and dsh usage is
# unknown rather than $0 — every named Go, apiserver (PostgreSQL + unit), Web and OrbitKit scenario.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
node scripts/test-dsh-failure-semantics.mjs
