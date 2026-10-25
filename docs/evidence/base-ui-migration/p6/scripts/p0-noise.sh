#!/usr/bin/env bash
# p0-noise.sh RUN: how far one tree's P0 page matrix screenshots move between two runs of the same build, against the
# reference/delivery differences of formal.sh RUN. Runs the P0 matrix once more on the reference and on the delivery
# (p0-ref2, p0-del2: P3.2's p32-reference.config.mjs writing its own screenshots), each alone in a memory-capped scope
# with a raised OOM score and its own network namespace, then compares ref with ref2, del with del2 and ref2 with del2
# (P3.2's compare_runs.py, P4.1's summarize.py) into v1/RUN/noise. Reads formal.sh's p0-ref and p0-del output.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=$V/$RUN
E=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e/docs/evidence/base-ui-migration
export TMPDIR=$V/tmp
mkdir -p "$R/noise"
run() {
  local name=$1 tree=$2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done"; return 0; fi
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available"; exit 3; fi
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  cp $E/p3.2/p32-reference.config.mjs $tree/src/web/ui-migration/
  { echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd $tree/src/web && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
      env P32_SNAPSHOTS=$R/$name-shots P32_OUTPUT=$R/$name-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all ) >> "$R/$name.txt" 2>&1
  echo "exit=$?" >> "$R/$name.txt"
  rm -f $tree/src/web/ui-migration/p32-reference.config.mjs
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" "$R/$name.txt"
}
run p0-ref2 $V/ref
run p0-del2 $V/del
for pair in "p0-ref p0-ref2" "p0-del p0-del2" "p0-ref2 p0-del2"; do
  set -- $pair
  python3 -I $E/p3.2/compare_runs.py $R/$1-shots $R/$2-shots $R/$1-out/report.json $R/$2-out/report.json $R/noise/$1-vs-$2.json > /dev/null
  python3 -I $E/p4.1/summarize.py $R/noise/$1-vs-$2.json > $R/noise/$1-vs-$2.summary.json
  echo "== $1 vs $2: $(python3 -I -c "import json, sys; d = json.load(open(sys.argv[1])); print(d['screenshots'], [(b['shot'], b['pixels'], b['max']) for b in d['beyond']])" $R/noise/$1-vs-$2.summary.json)"
  python3 -I -c "
import json, sys
d = json.load(open(sys.argv[1]))
for name, shot in sorted(d['screenshots'].items()):
    if not shot.get('equal'): print('   ', name, shot.get('pixels'), shot.get('maxChannelDiff'))
" $R/noise/$1-vs-$2.json
done
