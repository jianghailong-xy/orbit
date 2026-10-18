#!/usr/bin/env bash
# T07 Docker phase, part 1. eve, a new account with a key, waits for capacity (dora holds the pool's one runner slot) and
# her first session is sent from the draft as the iPhone sends it. Then a container of this instance that no runner
# records (an orphan, made outside the manager with the instance's label, never started) holds the channel's only place
# (limits.maxContainers 1): when dora sleeps, the pool admits eve, and the channel refuses her container, CONTAINER_LIMIT
# (D7's second case). The orphan removed, eve starts. Later, asleep, she is woken by a message with an orphan holding the
# place again: waking, at the cap. The web watches eve.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env-docker.sh
cd "$RUN"
orphan() {  # on|off
  if [ "$1" = on ]; then
    docker create --name t07-orphan --label orbit.managed-runner.instance=t07dock --label orbit.test=t07-docker \
      --network none alpine:3 true
  else
    docker rm -f t07-orphan
  fi
  docker ps -a --filter label=orbit.managed-runner.instance=t07dock --format '{{.Names}} {{.Status}}'
}
sleep 5
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" first-session --prompt "T07-EVE-S1 a first session while the managed environment has no room" \
  | tee "$RUN/eve-s1.done"
python3 -I -c "
import json,re
d=json.load(open('$RUN/eve-s1.done'))
print(re.search(r'\"id\":\"([0-9A-Za-z]+)\"', d['answer']).group(1))" > "$RUN/eve-session.id"
echo "eve session $(cat "$RUN/eve-session.id")"
sleep 20
date -u +%FT%T.%3NZ | tee "$RUN/orphan-1.on"
orphan on
$D release dora > "$RUN/09-release-dora.json" 2>&1; echo "release dora exit=$?"
$D until eve STARTING --reason CONTAINER_LIMIT --timeout 200 > "$RUN/10-eve-cap.json" 2>&1; echo "eve at cap exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/10-eve-cap.json'));print('eve at the cap', d['changes'][-1])"
sleep 45
date -u +%FT%T.%3NZ | tee "$RUN/orphan-1.off"
orphan off
$D until eve READY --timeout 200 > "$RUN/11-eve-ready.json" 2>&1; echo "eve ready exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/11-eve-ready.json'));print('eve ready', d['changes'][-1])"
sleep 15
date -u +%FT%T.%3NZ | tee "$RUN/eve-cap-1.end"
# The waking variant.
$D release eve > "$RUN/12-eve-sleep.json" 2>&1; echo "eve sleep exit=$?"
$D until eve SLEEPING --timeout 200 > "$RUN/13-eve-sleeping.json" 2>&1; echo "eve sleeping exit=$?"
sleep 15
date -u +%FT%T.%3NZ | tee "$RUN/orphan-2.on"
orphan on
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" message --session "$(cat "$RUN/eve-session.id")" --prompt "T07-EVE-M1 wake while the Docker host is at its cap"
date -u +%FT%T.%3NZ | tee "$RUN/eve-m1.at"
$D until eve STARTING --reason CONTAINER_LIMIT --timeout 120 > "$RUN/14-eve-cap-wake.json" 2>&1; echo "eve wake at cap exit=$?"
sleep 45
date -u +%FT%T.%3NZ | tee "$RUN/orphan-2.off"
orphan off
$D until eve READY --timeout 200 > "$RUN/15-eve-ready.json" 2>&1; echo "eve ready exit=$?"
sleep 15
date -u +%FT%T.%3NZ | tee "$RUN/eve-cap-2.end"
