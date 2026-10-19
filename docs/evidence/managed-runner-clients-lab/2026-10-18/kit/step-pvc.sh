#!/usr/bin/env bash
# T07 lab step: nia's runner asleep (it slept by itself, idle, at 06:23:52), its data volume's claim deleted (the PV
# and the RBD image are kept: Retain), a message that wakes it (sent as the iPhone sends it), and the failure that
# follows (PVC_MISSING, not retryable: no empty volume is made in its place).
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env.sh
cd "$RUN"
S=34hu0yWhtIlaZz1eVBWTZ
$W until nia SLEEPING --timeout 60 > "$RUN/54-nia-sleeping.json" 2>&1; echo "sleeping exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/54-nia-sleeping.json'));print('asleep at', d['at'])"
$L pvc-delete nia > "$RUN/55-pvc-delete.json" 2>&1; echo "pvc delete exit=$?"; cat "$RUN/55-pvc-delete.json"
sleep 10
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/nia" message --session $S --prompt "T07-NIA-D1 wake after the volume claim was deleted"
date -u +%FT%T.%3NZ | tee "$RUN/nia-d1.at"
$W until nia FAILED --reason PVC_MISSING --timeout 150 > "$RUN/56-nia-pvc-missing.json" 2>&1; echo "pvc missing exit=$?"
python3 -I -c "import json;d=json.load(open('$RUN/56-nia-pvc-missing.json'));print('failed at', d['at'])"
sleep 40
date -u +%FT%T.%3NZ | tee "$RUN/nia-pvc.end"
