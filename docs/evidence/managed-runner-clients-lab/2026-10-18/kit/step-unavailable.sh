#!/usr/bin/env bash
# T07 lab step: the switch on with an environment profile this server cannot use (its backend named as neither
# kubernetes nor docker) -- MANAGED_RUNNER_UNAVAILABLE: nothing reconciles, nothing is offered. Watched for a minute
# by the web and the native recorder on wen (asleep, no stored reason), then the profile put back and the server
# started again as it was.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env.sh
cd "$RUN"
P="$LAB_TEST_SERVER_DIR/managed-runner-profile.json"
cp -p "$P" "$P.saved"
systemctl stop orbit-mr-lab-api
python3 -I - "$P" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p['backend'] = 'neither'
open(sys.argv[1], 'w').write(json.dumps(p, indent=2))
PY
$TS start --managed > "$RUN/57-server-unavailable.txt" 2>&1; echo "server exit=$?"; tail -2 "$RUN/57-server-unavailable.txt"
date -u +%FT%T.%3NZ | tee "$RUN/unavailable.start"
grep -a 'enabled but unavailable' "$LAB_TEST_SERVER_DIR/logs/apiserver.log" | tail -2
sleep 75
date -u +%FT%T.%3NZ | tee "$RUN/unavailable.end"
systemctl stop orbit-mr-lab-api
cp -p "$P.saved" "$P"
$TS start --managed > "$RUN/58-server-on-again.txt" 2>&1; echo "server exit=$?"; tail -2 "$RUN/58-server-on-again.txt"
date -u +%FT%T.%3NZ | tee "$RUN/on-again.at"
