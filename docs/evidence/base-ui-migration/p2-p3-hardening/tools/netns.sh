#!/usr/bin/env bash
# netns.sh <command string> — P3.3's p33/tools/netns.sh: run it in a private network namespace (own
# 127.0.0.1), so the fixed preview ports of parallel runs on this shared host never meet.
exec unshare -n bash -c 'ip link set lo up && eval "$0"' "$1"
