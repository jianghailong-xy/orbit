#!/usr/bin/env bash
# geom.sh TREE LABEL [PROJECT...]: P4.3a's own keys geometry probe (probe/p43a-keys-geom-probe.browser.mjs, copied
# byte for byte from docs/evidence/base-ui-migration/p4.3a/scripts/probe/) on one tree: 8 runs per project, WebKit light
# and dark desktop unless projects are given; own network namespace and memory-capped scope; on trees from before
# P4.3a the P4.3a fixtures and config it runs under are copied in for the run. Output under runs/geom-LABEL.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
export TMPDIR=$T/tmp
tree=$1; label=$2; shift 2
projects=("$@"); [ ${#projects[@]} -gt 0 ] || projects=(webkit-light-desktop webkit-dark-desktop)
out=$T/runs/geom-$label
mkdir -p "$out"
ui=$T/$tree/src/web/ui-migration
added=()
for f in p43a-fixtures.mjs p43a.config.mjs; do
  [ -f "$ui/$f" ] || { cp "$T/tip/src/web/ui-migration/$f" "$ui/"; added+=("$ui/$f"); }
done
cp "$T/probe/p43a-keys-geom-probe.browser.mjs" "$ui/"; added+=("$ui/p43a-keys-geom-probe.browser.mjs")
args=(); for p in "${projects[@]}"; do args+=(--project "$p"); done
{ echo "tree: $tree $(git -C "$T/$tree" rev-parse HEAD) dirty: $(git -C "$T/$tree" status --porcelain | grep -v '^??' | wc -l)"; echo "load: $(cat /proc/loadavg)"; echo "root: $(df -BM --output=avail / | tail -1)"; echo "started: $(date -u +%FT%TZ)"; echo "projects: ${projects[*]}"; } > "$out/run.txt"
( cd "$T/$tree/src/web" && "$T/scripts/scoped.sh" nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" \
    npx playwright test ui-migration/p43a-keys-geom-probe.browser.mjs --config ui-migration/p43a.config.mjs "${args[@]}" ) >> "$out/run.txt" 2>&1
echo "exit=$?" >> "$out/run.txt"; echo "ended: $(date -u +%FT%TZ) load: $(cat /proc/loadavg)" >> "$out/run.txt"
rm -f "${added[@]}"
echo "== $label: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
