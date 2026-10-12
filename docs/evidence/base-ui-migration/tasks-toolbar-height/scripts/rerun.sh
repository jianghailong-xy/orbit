#!/usr/bin/env bash
# rerun.sh: every run of this task again, after collect.sh's first version emptied $T/runs, exp, compare and shots
# (2026-10-10 00:52Z). Same scripts, same trees and commits; resumable: a step whose log already ends with an exit code
# is skipped, so relaunching after a recycle repeats only the step that was cut off.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs
export TMPDIR=$T/tmp
mkdir -p "$R" "$T/exp"
done_() { grep -q '^exit=' "$1" 2>/dev/null; }
exp_run() {  # exp_run NAME ARGS...: a standalone page script from the delivery's src/web (it has @playwright/test)
  local name=$1 script=$2; shift 2
  done_ "$T/exp/$name.txt" && { echo "== $name already done"; return; }
  cp "$T/exp/$script" "$T/fix/src/web/$script.tmp.mjs"
  { echo "argv: node $script $*  (from the delivery's src/web)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo
    (cd "$T/fix/src/web" && "$T/scripts/scoped.sh" node "$script.tmp.mjs" "$@"); echo "exit=$?"; echo "ended: $(date -u +%FT%TZ)"; } > "$T/exp/$name.txt" 2>&1
  rm -f "$T/fix/src/web/$script.tmp.mjs"
  echo "== $name: $(grep -c . "$T/exp/$name.txt") lines, $(grep '^exit=' "$T/exp/$name.txt")"
}
dir_run() {  # dir_run LOGDIR SCRIPT ARGS...: probe.sh / flows.sh / geom.sh, unless their run.txt is complete
  local dir=$1; shift
  done_ "$R/$dir/run.txt" && { echo "== $dir already done"; return; }
  "$@"
}
echo "== rerun started $(date -u +%T)"
exp_run min2-webkit min2.mjs webkit
exp_run min2-chromium min2.mjs chromium
exp_run scrollbar-room scrollbar-room.mjs
"$T/scripts/stats.sh" 1 4
dir_run probe-tip-1 "$T/scripts/probe.sh" tip tip-1
dir_run probe-pre-1 "$T/scripts/probe.sh" pre pre-1
dir_run probe-fix-1 "$T/scripts/probe.sh" fix fix-1
dir_run flows-tip-1 "$T/scripts/flows.sh" tip tip-1
dir_run flows-pre-1 "$T/scripts/flows.sh" pre pre-1
dir_run flows-fix-1 "$T/scripts/flows.sh" fix fix-1
dir_run geom-tip-phone "$T/scripts/geom.sh" tip tip-phone webkit-light-phone webkit-dark-phone
dir_run geom-fix-phone "$T/scripts/geom.sh" fix fix-phone webkit-light-phone webkit-dark-phone
"$T/scripts/final.sh" stats
"$T/scripts/final.sh" p43a
[ -f "$T/compare/p43a-summary.json" ] || "$T/scripts/compare.sh"
"$T/scripts/final.sh" p0
"$T/scripts/final.sh" audit
for tree in tip base; do
  [ -s "$R/audit-check-owners-$tree.json" ] || (cd "$T/$tree" && node src/web/scripts/audit-antd.mjs --check-owners > "$R/audit-check-owners-$tree.json" 2>&1; echo "== audit $tree exit=$?")
done
"$T/scripts/small.sh"
echo "== rerun done $(date -u +%T)"
