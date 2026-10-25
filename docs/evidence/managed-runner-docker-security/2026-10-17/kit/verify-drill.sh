#!/bin/bash
# D5: volume-backup.sh check and verify of the final script on the test host. check against b's last backup; verify
# refused on a running runner's volume (a), done on a sleeping one (b), failing on a scratch volume with a broken
# SQLite file. Each runner's state is asserted, not assumed.
set -uo pipefail
cd /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind/work
D="python3 -I kit/drill.py"
run() { echo "\$ scripts/managed-runner/volume-backup.sh $*"; docker exec -w /work/orbit d5-dind bash /work/kit/volume-backup.sh "$@" 2>&1; echo "exit=$?"; }
state() { $D mapping "$1" | python3 -c 'import json,sys; m=json.load(sys.stdin); print(m["state"], "generation", m["generation"], "container", m["container"])'; }
must() { local s; s=$(state "$1"); echo "$1: $s"; case "$s" in "$2"*) ;; *) echo "expected $1 $2"; exit 1 ;; esac; }
for k in a b; do
  if state $k | grep -q '^FAILED'; then $D retry $k >/dev/null && $D follow $k "$k retried before the verify drill" READY >/dev/null; fi
  must $k READY
done
A=$($D mapping a | python3 -c 'import json,sys; print(json.load(sys.stdin)["volume"])')
B=$($D mapping b | python3 -c 'import json,sys; print(json.load(sys.stdin)["volume"])')
echo "a's container: $(docker exec d5-dind docker ps --filter volume=$A --format '{{.Names}} {{.Status}}')"
run verify "$A"
run check "$B" "$(cat last-backup)"
$D sleep b >/dev/null && $D follow b "b asleep for verify" SLEEPING >/dev/null
must b SLEEPING
echo "containers referring to b's volume: [$(docker exec d5-dind docker ps -aq --filter volume=$B)]"
run verify "$B"
X=mr-data-00000000-0000-4000-8000-0000000000d5
docker exec d5-dind sh -c "docker volume create $X >/dev/null && docker run --rm --network none -v $X:/var/lib/orbit alpine:3 sh -c 'mkdir -p /var/lib/orbit/home && head -c 8192 /dev/urandom > /var/lib/orbit/home/broken.sqlite && chown -R 10001:10001 /var/lib/orbit'"
run verify "$X"
docker exec d5-dind docker volume rm "$X" >/dev/null && echo "scratch volume $X removed"
$D wake b >/dev/null && $D follow b "b woken after verify" READY >/dev/null
must b READY
