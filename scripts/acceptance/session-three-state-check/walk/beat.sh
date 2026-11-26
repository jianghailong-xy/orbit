#!/usr/bin/env bash
# Keep the walk's runner heard from (runner.last_heartbeat_at = now() every 15 s), as the payloads fixture does at
# creation: a runner silent for 90 s is offline, and a queued row then reads its runner gate instead of its hold.
# usage: beat.sh <postgres container> <runner uuid>   (runs until killed)
set -u
container=$1 runner=$2
while true; do
  docker exec "$container" psql -U orbit -d orbit -qAt -c "UPDATE runner SET last_heartbeat_at = now() WHERE id = '$runner'::uuid" >/dev/null 2>&1
  sleep 15
done
