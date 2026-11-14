#!/usr/bin/env bash
# cadence.sh <since> <until>: the seconds at which channel B was asked about its runners' containers (GET /v1/containers/<one
# runner>), which the B host's manager asks once per pass for each READY runner: the gaps between them are B's pass cadence.
set -euo pipefail
first=$(docker exec mrmh-chan-b docker ps --filter label=orbit.managed-runner.kind=runner --format '{{.Names}}' | sort | head -1)
docker exec mrmh-chan-b docker logs --since "$1" --until "$2" orbit-docker-channel 2>&1 | grep "GET /v1/containers/$first " \
  | awk '{print $1}' | python3 -c '
import sys, datetime
ts=[datetime.datetime.fromisoformat(l.strip().replace("Z","+00:00")) for l in sys.stdin if l.strip()]
gaps=[(b-a).total_seconds() for a,b in zip(ts,ts[1:])]
print(f"container {sys.argv[1]}: {len(ts)} reads; gaps between passes (s): {[int(g) for g in gaps]}; max {max(gaps) if gaps else None}")
' "$first"
