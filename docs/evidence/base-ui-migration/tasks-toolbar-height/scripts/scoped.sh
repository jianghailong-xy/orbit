#!/usr/bin/env bash
# scoped.sh CMD...: the project's rule for heavy runs -- its own cgroup capped at 6G, preferred by the OOM killer.
exec systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh "$@"
