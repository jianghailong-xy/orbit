#!/usr/bin/env bash
# probe-geom.sh TREE: the keys geometry probe (probe/geom/p43a-keys-geom-probe.browser.mjs) on one tree of round 5,
# WebKit dark desktop (where both list positions showed in the repeat runs), in its own network namespace; the probe
# file is copied into the tree for the run and removed after. Prints the KEYS-GEOM lines; output under
# v1/probe-geom/<tree>.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
export TMPDIR=$V/tmp
tree=$1
out=$V/probe-geom/$tree
mkdir -p "$out"
cp "$V/probe/geom/p43a-keys-geom-probe.browser.mjs" "$V/$tree/src/web/ui-migration/"
{ echo "tree: $tree $(git -C "$V/$tree" rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; } > "$out/run.txt"
( cd "$V/$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" \
    npx playwright test ui-migration/p43a-keys-geom-probe.browser.mjs --config ui-migration/p43a.config.mjs \
    --project webkit-dark-desktop ) >> "$out/run.txt" 2>&1
echo "exit=$?" >> "$out/run.txt"
rm -f "$V/$tree/src/web/ui-migration/p43a-keys-geom-probe.browser.mjs"
echo "== $tree: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
grep -o 'KEYS-GEOM.*' "$out/run.txt"
