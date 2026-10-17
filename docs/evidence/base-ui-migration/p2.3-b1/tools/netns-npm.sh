#!/usr/bin/env bash
# Usage: netns-npm.sh <tree> <outdir> <results-subdir> <npm-script> [playwright args]
# The unchanged `NO_COLOR=1 npm run <npm-script> -w @orbit/web [-- args]` in <tree>, inside its own network
# namespace (its fixed port is private to this run). Then copies src/web/<results-subdir> (report and
# attachments) to <outdir>/results and collects the attachments (collect-run.py).
TREE=$1 OUT=$2 RES=$3 SCRIPT=$4; shift 4
mkdir -p "$OUT"
rm -rf "$TREE/src/web/$RES"
{ echo "# tree $TREE commit $(git -C "$TREE" rev-parse HEAD) status: $(git -C "$TREE" status --porcelain -- src | tr '\n' ' ')"; echo "# argv: NO_COLOR=1 npm run $SCRIPT -w @orbit/web ${*:+-- $*}"; echo "# started $(date -u +%FT%TZ)"; } > "$OUT/command-output.txt"
if [ $# -gt 0 ]; then
  unshare -n bash -c 'ip link set lo up && cd "$0" && NO_COLOR=1 npm run "$1" -w @orbit/web -- "${@:2}"' "$TREE" "$SCRIPT" "$@" >> "$OUT/command-output.txt" 2>&1
else
  unshare -n bash -c 'ip link set lo up && cd "$0" && NO_COLOR=1 npm run "$1" -w @orbit/web' "$TREE" "$SCRIPT" >> "$OUT/command-output.txt" 2>&1
fi
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> "$OUT/command-output.txt"
cp -r "$TREE/src/web/$RES" "$OUT/results"
[ -f "$TREE/src/web/.ui-migration-results/environment.json" ] && cp "$TREE/src/web/.ui-migration-results/environment.json" "$OUT/"
python3 /var/tmp/p23b1/scripts/collect-run.py "$OUT/results" "$OUT/collected" > "$OUT/collect.json" 2>&1
echo "exit $code" | tee "$OUT/exit.txt"
exit $code
