#!/usr/bin/env bash
# T07 Docker phase, part 1: the host at its cap on runner containers (the channel's limits.maxContainers 1, under a
# budget of two runners). dora (the bootstrap admin) holds the one container; eve, a new account with a key, is admitted
# by the budget but refused a container (CONTAINER_LIMIT): preparing, with the cap's sentence, a first session offered.
# Then dora sleeps and eve starts; later dora is woken by a message and holds the container again while eve, asleep, is
# woken by a message (sent as the iPhone sends it): waking, with the cap's sentence. The web watches eve.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env-docker.sh
mkdir -p "$RUN/web" "$RUN/rec"
cd "$RUN"
$D account dora > "$RUN/01-dora.json" 2>&1; echo "dora exit=$?"
$D key dora > "$RUN/02-dora-key.json" 2>&1; echo "dora key exit=$?"
$D until dora READY --timeout 300 > "$RUN/03-dora-ready.json" 2>&1; echo "dora ready exit=$?"
$D hold dora > "$RUN/04-dora-hold.json" 2>&1; echo "dora hold exit=$?"
$D account eve --no-signin > "$RUN/05-eve.json" 2>&1; echo "eve exit=$?"
# eve's first sign-in is the web's, through the login page; the recorder signs in after it.
unit t07d-web-eve 900M /usr/local/bin/node "$KIT/t07web.mjs" run --account eve --out "$RUN/web/eve" --base "http://127.0.0.1:$WEB_PORT" --start /
date -u +%FT%T.%3NZ | tee "$RUN/eve-web.start"
sleep 6
unit t07d-rec-eve 256M /usr/bin/python3 -I "$KIT/t07rec.py" run --account eve --out "$RUN/rec/eve" --client ios
date -u +%FT%T.%3NZ | tee "$RUN/scene-eve.start"
sleep 5
$D account eve > "$RUN/06-eve-signin.json" 2>&1; echo "eve signin exit=$?"
$D key eve > "$RUN/07-eve-key.json" 2>&1; echo "eve key exit=$?"
$D until eve STARTING --reason CONTAINER_LIMIT --timeout 200 > "$RUN/08-eve-limit.json" 2>&1; echo "eve limit exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/08-eve-limit.json'));print('eve at the cap', d['changes'][-1])"
sleep 15
# The first session from the draft, as the iPhone sends it, while eve waits at the cap.
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" first-session --prompt "T07-EVE-S1 a first session while the Docker host is at its cap" \
  | tee "$RUN/eve-s1.done"
python3 -I -c "
import json,re
d=json.load(open('$RUN/eve-s1.done'))
print(re.search(r'\"id\":\"([0-9A-Za-z]+)\"', d['answer']).group(1))" > "$RUN/eve-session.id"
echo "eve session $(cat "$RUN/eve-session.id")"
sleep 30
date -u +%FT%T.%3NZ | tee "$RUN/release-dora-1.at"
$D release dora > "$RUN/09-release-dora.json" 2>&1; echo "release exit=$?"
$D until eve READY --timeout 300 > "$RUN/10-eve-ready.json" 2>&1; echo "eve ready exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/10-eve-ready.json'));print('eve ready', d['changes'][-1])"
sleep 15
# eve to sleep, dora woken by a message and holding the container again.
$D release eve > "$RUN/11-eve-sleep.json" 2>&1; echo "eve sleep exit=$?"
$D until eve SLEEPING --timeout 200 > "$RUN/12-eve-sleeping.json" 2>&1; echo "eve sleeping exit=$?"
$D hold dora > "$RUN/13-dora-hold-again.json" 2>&1; echo "dora hold exit=$?"
$D until dora READY --timeout 300 > "$RUN/14-dora-ready-again.json" 2>&1; echo "dora ready exit=$?"
date -u +%FT%T.%3NZ | tee "$RUN/eve-asleep-dora-holds.at"
sleep 15
# eve, asleep, woken by a message while dora holds the one container: waking, at the cap.
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" message --session "$(cat "$RUN/eve-session.id")" --prompt "T07-EVE-M1 wake while the Docker host is at its cap"
date -u +%FT%T.%3NZ | tee "$RUN/eve-m1.at"
$D until eve STARTING --reason CONTAINER_LIMIT --timeout 120 > "$RUN/15-eve-limit-wake.json" 2>&1; echo "eve wake at cap exit=$?"
sleep 45
date -u +%FT%T.%3NZ | tee "$RUN/release-dora-2.at"
$D release dora > "$RUN/16-release-dora.json" 2>&1; echo "release exit=$?"
$D until eve READY --timeout 300 > "$RUN/17-eve-ready.json" 2>&1; echo "eve ready exit=$?"
sleep 15
date -u +%FT%T.%3NZ | tee "$RUN/eve-limit.end"
