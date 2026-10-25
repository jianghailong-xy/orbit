#!/usr/bin/env bash
# harness-check.sh RUN [TREE [NAME...]]: the two batch tools whose entries P6 changed (reviews.tsx, p43b-cards.tsx now
# mount AppRoot with Orbit's root styles and reset instead of ConfigProvider/AntApp) run once on TREE (del, the default,
# or base: the entries as they were): their cases still load and pass. p43b-cards writes its screenshots (a same-commit
# tool, nothing to compare against here). Same wrappers as formal.sh; logs and reports in v1/RUN, prefixed with the
# tree for the base.
set -u
RUN=${1:?run name}; TREE=${2:-del}; shift $(( $# < 2 ? $# : 2 ))
NAMES=("$@"); [ ${#NAMES[@]} -gt 0 ] || NAMES=(reviews p43b-cards)
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
R=$V/$RUN
DEL=$V/$TREE
P=harness-; [ "$TREE" = del ] || P=harness-$TREE-
export TMPDIR=$V/tmp
for name in "${NAMES[@]}"; do
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  { echo "tree: $DEL"; echo "head: $(git -C $DEL rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$P$name.txt"
  ( cd $DEL/src/web && rm -rf .reviews-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43B_SNAPSHOTS=$R/${P}p43b-cards-shots P43B_OUTPUT=$R/${P}p43b-cards-out P43B_PORT=4177 \
      npx playwright test --config ui-migration/$name.config.mjs --update-snapshots=all ) >> "$R/$P$name.txt" 2>&1
  { echo "exit=$?"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$P$name.txt"
  [ "$name" = reviews ] && { rm -rf "$R/${P}reviews-out"; cp -a $DEL/src/web/.reviews-results "$R/${P}reviews-out"; }
  echo "== $name: $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$R/$P$name.txt" | tr -s ' ' | tr '\n' ' ') $(grep '^exit=' "$R/$P$name.txt")"
done
