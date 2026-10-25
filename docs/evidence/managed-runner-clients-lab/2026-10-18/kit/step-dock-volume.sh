#!/usr/bin/env bash
# T07 Docker phase, part 2: eve's data volume held by another container (VOLUME_IN_USE), then removed and restored by the
# runbook (scripts/managed-runner/volume-backup.sh): PVC_MISSING, then PVC_RESTORED with Retry offered, which the
# recorder presses as the iPhone does. Each wake is a message sent as the iPhone sends it. The web watches eve.
set -uo pipefail
source /mnt/data/tmp/t07-34ZtjU1Q/kit/env-docker.sh
cd "$RUN"
EVE_S1=$(cat "$RUN/eve-session.id")
sleep 10
$D release eve > "$RUN/20-eve-sleep.json" 2>&1; echo "eve sleep exit=$?"
$D until eve SLEEPING --timeout 200 > "$RUN/21-eve-sleeping.json" 2>&1; echo "eve sleeping exit=$?"
sleep 15
$D holder eve on > "$RUN/22-holder-on.json" 2>&1; echo "holder on exit=$?"; cat "$RUN/22-holder-on.json"
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" message --session "$EVE_S1" --prompt "T07-EVE-V1 wake while another container holds the volume"
date -u +%FT%T.%3NZ | tee "$RUN/eve-v1.at"
$D until eve STARTING --reason VOLUME_IN_USE --timeout 120 > "$RUN/23-eve-volume-held.json" 2>&1; echo "held exit=$?"
sleep 45
date -u +%FT%T.%3NZ | tee "$RUN/holder-off.at"
$D holder eve off > "$RUN/24-holder-off.json" 2>&1; echo "holder off exit=$?"
$D until eve READY --timeout 200 > "$RUN/25-eve-ready.json" 2>&1; echo "eve ready exit=$?"
sleep 20
date -u +%FT%T.%3NZ | tee "$RUN/eve-volume-held.end"
# The runbook: back up while asleep, the volume removed, a wake that fails, the restore, the retry.
$D release eve > "$RUN/26-eve-sleep.json" 2>&1; echo "eve sleep exit=$?"
$D until eve SLEEPING --timeout 200 > "$RUN/27-eve-sleeping.json" 2>&1; echo "eve sleeping exit=$?"
$D backup eve > "$RUN/28-backup.json" 2>&1; echo "backup exit=$?"; tail -c 600 "$RUN/28-backup.json"
$D remove eve > "$RUN/29-remove.json" 2>&1; echo "remove exit=$?"; cat "$RUN/29-remove.json"
sleep 10
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" message --session "$EVE_S1" --prompt "T07-EVE-R1 wake after the volume was removed"
date -u +%FT%T.%3NZ | tee "$RUN/eve-r1.at"
$D until eve FAILED --reason PVC_MISSING --timeout 120 > "$RUN/30-eve-missing.json" 2>&1; echo "missing exit=$?"
sleep 30
date -u +%FT%T.%3NZ | tee "$RUN/restore.at"
$D restore eve > "$RUN/31-restore.json" 2>&1; echo "restore exit=$?"; tail -c 900 "$RUN/31-restore.json"
$D until eve FAILED --reason PVC_RESTORED --timeout 180 > "$RUN/32-eve-restored.json" 2>&1; echo "restored exit=$?"
sleep 20
python3 -I "$KIT/t07rec.py" act --out "$RUN/rec/eve" retry
date -u +%FT%T.%3NZ | tee "$RUN/eve-retry.at"
$D until eve READY --timeout 300 > "$RUN/33-eve-ready.json" 2>&1; echo "eve ready exit=$?"
sleep 30
date -u +%FT%T.%3NZ | tee "$RUN/eve-volume.end"
