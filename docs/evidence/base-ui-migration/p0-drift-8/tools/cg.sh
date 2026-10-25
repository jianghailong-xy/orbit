#!/usr/bin/env bash
# Usage: cg.sh <command...>
# The project's rule for heavy steps (2026-10-09): run in its own cgroup capped at 6G with a high OOM score, so an
# OOM kill takes this command and not the runner (OOMPolicy=stop).
exec systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh "$@"
