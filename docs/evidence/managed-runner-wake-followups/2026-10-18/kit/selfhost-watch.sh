#!/usr/bin/env bash
# Observe the real self-managed runner's row and its one lab session every 0.5 s for $2 seconds (the lab's
# test database, not Orbit): the heartbeat stamp, the session's claim and status. One JSON line each.
D=$1
SECONDS_TO_WATCH=$2
end=$(( $(date +%s) + SECONDS_TO_WATCH ))
while [ "$(date +%s)" -lt "$end" ]; do
  python3 /mnt/data/tmp/34hpKqWRaAJbUXoikQ3U4/kit/selfhost-real.py observe "$D" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)))'
  sleep 0.5
done
