#!/usr/bin/env bash
# fixtures-rerun.sh RUN: the six fixture configs on the delivery once more (fixtures-del2-*), the noise baseline for
# formal.sh RUN's before/after comparison: an attachment that also differs between two runs of the same delivery is
# timing, not P6. Same wrappers as formal.sh (MemAvailable gate, memory-capped scope, raised OOM score, own network
# namespace); outputs in v1/RUN.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=$V/$RUN
DEL=$V/del
export TMPDIR=$V/tmp
for config in foundation controls overlays choices toasts composer; do
  name=fixtures-del2-$config
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done"; continue; fi
  a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9'); [ "$a" -lt 2048 ] && { echo "== STOP: / has ${a}M available"; exit 3; }
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  { echo "tree: $DEL"; echo "head: $(git -C $DEL rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd $DEL/src/web && rm -rf .$config-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/$config.config.mjs ) >> "$R/$name.txt" 2>&1
  { echo "exit=$?"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  rm -rf "$R/$name-out"; cp -a $DEL/src/web/.$config-results "$R/$name-out"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" "$R/$name.txt"
done
