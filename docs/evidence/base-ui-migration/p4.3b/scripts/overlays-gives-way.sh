#!/usr/bin/env bash
# overlays-gives-way.sh LABEL: the overlays matrix case "a dialog taller than the screen keeps its scroll when the
# control with focus gives way" on try/aux-del, all eight projects, in its own network namespace.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
T=$V/try/aux-del/src/web
label=$1
export TMPDIR=$V/tmp
. $V/scripts/memgate.sh
cd $T && scoped unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/overlays.config.mjs \
  -g 'keeps its scroll when the control with focus gives way' --reporter=list 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > $V/extra/overlays-gives-way-$label.txt
grep -E "✓|✘|passed|failed|Expected|Received" $V/extra/overlays-gives-way-$label.txt | head -40
