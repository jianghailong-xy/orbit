#!/usr/bin/env bash
# Usage: queue.sh <lanes> <tree:runner:label> ...
# Runs run.sh for each item, <lanes> at a time, each in its own network namespace (run.sh). Resumable:
# run.sh keeps a run that already finished. Builds the tree first when it is missing (prepare-tree.sh).
B=/mnt/data/tmp/34cFgyWHIYDslABFPloEM
LANES=$1; shift
lane() {
  for item in "$@"; do
    IFS=: read -r tree runner label <<<"$item"
    [ -f "$B/trees/$tree/.built" ] || nice -n 10 bash $B/scripts/prepare-tree.sh "$tree" "$tree"
    echo "$(date -u +%FT%TZ) start $label"
    nice -n 5 bash $B/scripts/run.sh "$tree" "$runner" "$label"
    echo "$(date -u +%FT%TZ) end $label"
  done
}
items=("$@"); n=${#items[@]}
for ((l = 0; l < LANES; l++)); do
  mine=(); for ((i = l; i < n; i += LANES)); do mine+=("${items[i]}"); done
  lane "${mine[@]}" > "$B/logs/queue-lane-$l-$(date +%s).txt" 2>&1 &
done
wait
for item in "$@"; do IFS=: read -r tree runner label <<<"$item"; python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
print(sys.argv[2], m.get('exit'), m.get('environment'), m.get('stats'), m.get('screenshots'), m.get('evidence',{}).get('unhandled'))" "$B/runs/$label/meta.json" "$label" 2>/dev/null || echo "$label: no meta"; done
