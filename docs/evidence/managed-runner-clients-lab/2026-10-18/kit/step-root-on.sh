#!/usr/bin/env bash
# T07 lab step: an existing account (root: a self-managed runner, its workspace and a session, made with the switch
# unset) signs in with the switch on. Its sign-in provisions a managed runner and adds the managed default workspace;
# its own workspace, where it lands, its session's deep link and its runner stay as they were. The web signs in
# through the login page and takes pictures; the native recorder records what the apps would read.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env.sh
cd "$RUN"
O="$RUN/web/root-on"
unit t07-web-root-on 900M /usr/local/bin/node "$KIT/t07web.mjs" run --account root --out "$O" --base "http://127.0.0.1:$WEB_PORT" --start /
date -u +%FT%T.%3NZ | tee "$RUN/root-on-web.start"
sleep 6
unit t07-rec-root-on 256M /usr/bin/python3 -I "$KIT/t07rec.py" run --account root --out "$RUN/rec/root-on" --client ios
date -u +%FT%T.%3NZ | tee "$RUN/scene-root-on.start"
sleep 8
node "$KIT/t07web.mjs" act --out "$O" shot on-landing
node "$KIT/t07web.mjs" act --out "$O" goto /workspaces/34htasHVEnwCfDe1K58bE/new; sleep 5
node "$KIT/t07web.mjs" act --out "$O" shot on-selfhost-draft
node "$KIT/t07web.mjs" act --out "$O" goto /sessions/34htasQH9ZMfYI7kB46z6; sleep 5
node "$KIT/t07web.mjs" act --out "$O" shot on-session-deep-link
node "$KIT/t07web.mjs" act --out "$O" goto /infrastructure; sleep 6
node "$KIT/t07web.mjs" act --out "$O" shot on-infrastructure
sleep 60
touch "$O/stop" "$RUN/rec/root-on/stop"
date -u +%FT%T.%3NZ | tee "$RUN/scene-root-on.end"
python3 -I "$KIT/websummary.py" "$O" | tail -20
