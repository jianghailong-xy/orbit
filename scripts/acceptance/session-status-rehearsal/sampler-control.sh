#!/usr/bin/env bash
# Positive control for sample-locks.sh: start it the way rehearse.sh d1 does, plant a 3 s lock wait (one transaction
# holds the session table's ACCESS EXCLUSIVE lock, a second backend's UPDATE waits behind it), stop it, and count what
# it saw. A sampler that records no wait during the rehearsal is only evidence of no wait if it records this one.
#   sampler-control.sh <postgres container> <out.jsonl>
set -u
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pg=$1 out=$2
: > "$out"
setsid bash "$HERE/sample-locks.sh" "$pg" "$out" > /dev/null 2>&1 < /dev/null &
sampler=$!
sleep 2
docker exec "$pg" psql -U orbit -d orbit -X -q -c "BEGIN; LOCK TABLE session IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); ROLLBACK;" > /dev/null &
holder=$!
sleep 0.5
docker exec "$pg" psql -U orbit -d orbit -X -q \
  -c "SET application_name = 'planted-waiter'" \
  -c "UPDATE session SET updated_at = updated_at WHERE id = (SELECT id FROM session ORDER BY id LIMIT 1)" > /dev/null
wait "$holder"
sleep 1
kill -- -"$sampler" 2>/dev/null
docker exec "$pg" psql -U orbit -d orbit -XAt -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 't16-lock-sampler'" > /dev/null
echo "samples with a waiter: $(wc -l < "$out"); with the planted waiter: $(grep -c planted-waiter "$out"); longest wait seen: $(grep -o '"waitingMs" : [0-9]*' "$out" | awk '{print $3}' | sort -n | tail -1) ms"
