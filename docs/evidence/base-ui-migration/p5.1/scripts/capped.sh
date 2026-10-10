#!/usr/bin/env bash
# Runs a command in its own systemd scope (outside the runner's cgroup) with a memory cap and a raised OOM score.
# Usage: capped.sh <MemoryMax> <command> [args...]
set -euo pipefail
max="$1"; shift
exec systemd-run --scope --quiet -p "MemoryMax=$max" "$(cd "$(dirname "$0")" && pwd)/oom-exec.sh" "$@"
