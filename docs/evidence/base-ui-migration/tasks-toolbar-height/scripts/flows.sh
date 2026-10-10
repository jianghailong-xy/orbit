#!/usr/bin/env bash
# flows.sh TREE LABEL [PROJECT...]: the transitions probe (probe/p43a-toolbar-flows-probe.browser.mjs) on one tree, as
# probe.sh runs the observation probe. Output under runs/flows-LABEL.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
export TMPDIR=$T/tmp
tree=$1; label=$2; shift 2
projects=("$@"); [ ${#projects[@]} -gt 0 ] || projects=(webkit-light-desktop webkit-dark-desktop)
out=$T/runs/flows-$label
mkdir -p "$out"
ui=$T/$tree/src/web/ui-migration
added=()
for f in p43a-fixtures.mjs p43a.config.mjs; do
  [ -f "$ui/$f" ] || { cp "$T/tip/src/web/ui-migration/$f" "$ui/"; added+=("$ui/$f"); }
done
cp "$T/probe/p43a-toolbar-flows-probe.browser.mjs" "$ui/"; added+=("$ui/p43a-toolbar-flows-probe.browser.mjs")
args=(); for p in "${projects[@]}"; do args+=(--project "$p"); done
{ echo "tree: $tree $(git -C "$T/$tree" rev-parse HEAD) dirty: $(git -C "$T/$tree" status --porcelain | grep -v '^??' | wc -l)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo "projects: ${projects[*]} runs: ${PROBE_RUNS:-4}"; } > "$out/run.txt"
( cd "$T/$tree/src/web" && "$T/scripts/scoped.sh" nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" PROBE_RUNS="${PROBE_RUNS:-4}" \
    npx playwright test ui-migration/p43a-toolbar-flows-probe.browser.mjs --config ui-migration/p43a.config.mjs "${args[@]}" ) >> "$out/run.txt" 2>&1
echo "exit=$?" >> "$out/run.txt"; echo "ended: $(date -u +%FT%TZ) load: $(cat /proc/loadavg)" >> "$out/run.txt"
rm -f "${added[@]}"
echo "== $label: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
