#!/usr/bin/env bash
# case-repeat.sh TREE OUT NAME [REPEAT]: choices.browser.mjs's "multiple labels search, toggle, collapse, remove and clear"
# case, the test file as it is in TREE, in both WebKit phone projects, --repeat-each REPEAT (default 10). The run sits
# alone in a memory-capped scope and its own network namespace (its dev server on 4177 cannot meet another session's).
# Writes OUT/NAME.txt (the list reporter, the tree and its edits), OUT/NAME.report.json (the raw JSON report) and
# OUT/NAME.report.summary.json (the same without attachment bodies, p0-drift-3's report-summary.py).
set -u
TREE=${1:?tree}; OUT=${2:?outdir}; NAME=${3:?name}; REPEAT=${4:-10}
HERE=$(cd "$(dirname "$0")" && pwd)
export TMPDIR=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg/tmp
mkdir -p "$OUT" "$TMPDIR"
for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
{ echo "tree: $TREE ($(git -C "$TREE" rev-parse --short HEAD))"; echo "edits:"; git -C "$TREE" diff --stat HEAD -- src/web | sed 's/^/  /'
  echo "load: $(cat /proc/loadavg)"; echo "available: $(free -m | awk '/Mem:/{print $7}') MB"; echo; } > "$OUT/$NAME.txt"
( cd "$TREE/src/web" && rm -rf .choices-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/choices.config.mjs \
    --project webkit-light-phone --project webkit-dark-phone -g "multiple labels search, toggle, collapse, remove and clear" --repeat-each "$REPEAT" ) >> "$OUT/$NAME.txt" 2>&1
rc=$?
echo "exit=$rc" >> "$OUT/$NAME.txt"
cp "$TREE/src/web/.choices-results/report.json" "$OUT/$NAME.report.json" 2>/dev/null &&
  python3 -I "$HERE/../../p0-drift-3/tools/report-summary.py" "$OUT/$NAME.report.json" "$OUT/$NAME.report.summary.json" > /dev/null
echo "== $NAME: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$OUT/$NAME.txt" | tr -s ' ' | tr '\n' ' ')$(grep -c 'ResizeObserver loop' "$OUT/$NAME.txt") ResizeObserver lines, exit=$rc"
exit $rc
