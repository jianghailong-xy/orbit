#!/usr/bin/env bash
# T07 lab step: nia's runner put to sleep by its owner, an attachment of its volume left behind, a message that wakes it
# (sent as the iPhone sends it), the wait that holds the start (VOLUME_IN_USE), the attachment removed, the answer.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env.sh
cd "$RUN"
S=34hu0yWhtIlaZz1eVBWTZ
$W until nia READY --timeout 200 > "$RUN/45-nia-ready.json" 2>&1; echo "ready exit=$?"
sleep 10
date -u +%FT%T.%3NZ | tee "$RUN/nia-sleep-2.at"
$L release nia > "$RUN/46-nia-sleep.json" 2>&1; echo "sleep exit=$?"
$W until nia SLEEPING --timeout 200 > "$RUN/47-nia-sleeping.json" 2>&1; echo "sleeping exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/47-nia-sleeping.json'));print('asleep at', d['at'])"
sleep 15
$L va nia on > "$RUN/48-va-on.json" 2>&1; echo "va on exit=$?"; cat "$RUN/48-va-on.json"
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/nia" message --session $S --prompt "T07-NIA-V1 wake while an attachment of the volume is left behind"
date -u +%FT%T.%3NZ | tee "$RUN/nia-v1.at"
$W until nia STARTING --reason VOLUME_IN_USE --timeout 150 > "$RUN/49-nia-volume-wait.json" 2>&1; echo "volume wait exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/49-nia-volume-wait.json'));print('held at', d['at'])"
sleep 45
date -u +%FT%T.%3NZ | tee "$RUN/va-off.at"
$L va nia off > "$RUN/50-va-off.json" 2>&1; echo "va off exit=$?"; cat "$RUN/50-va-off.json"
$W answered nia T07-NIA-V1 --timeout 240 > "$RUN/51-nia-v1.json" 2>&1; echo "v1 exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/51-nia-v1.json'));print('answered', d['answerEvent']['created_at'])"
