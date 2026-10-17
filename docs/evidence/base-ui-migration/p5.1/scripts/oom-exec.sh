#!/usr/bin/env bash
# Raises this process's OOM score, then becomes the given command.
echo 500 > /proc/self/oom_score_adj
exec "$@"
