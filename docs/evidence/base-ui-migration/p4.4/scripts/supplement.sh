#!/usr/bin/env bash
# supplement.sh MAIN: what follows the final round runs3, in turn (each part resumable):
#  1. p44-rerun.sh runs3: the P4.4 case that failed in the reference run, on both trees;
#  2. the choices lifecycle test that failed in chromium-light-desktop, alone, on the delivery and on the base, twice each;
#  3. merge-tree-check.sh MAIN runs3-merged: standard P0 and the P4.4 suite on the delivery merged with origin/main.
set -u
MAIN=${1:?main commit}
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
R=$V/runs3
export TMPDIR=$V/tmp
"$T/scripts/p44-rerun.sh" runs3
for tree in del base; do for n in 1 2; do
  name=choices-recheck-$tree-$n
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done"; continue; fi
  { echo "argv: npm run test:ui-choices -w @orbit/web -- --project chromium-light-desktop --grep 'no-preference Dialog Popover Select exits restore one layer at a time'"
    echo "tree: $V/$tree"; echo "head: $(git -C $V/$tree rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  ( cd "$V/$tree" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash \
      npm run test:ui-choices -w @orbit/web -- --project chromium-light-desktop --grep 'no-preference Dialog Popover Select exits restore one layer at a time' ) >> "$R/$name.txt" 2>&1
  code=$?; { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  echo "== $name exit=$code"; grep -E "^\s+[0-9]+ (passed|failed|flaky)" "$R/$name.txt"
done; done
"$T/scripts/merge-tree-check.sh" "$MAIN" runs3-merged
echo "== supplement done $(date -u +%T)"
