#!/usr/bin/env bash
# probe-keys.sh: the keys probe (probe/keys/p43a-keys-probe.browser.mjs) on each tree of round 5, WebKit light and dark
# desktop, each in its own network namespace; the probe file is copied into the tree for the run and removed after.
# Prints each run's KEYS-PROBE lines; output under v1/probe-keys/<tree>.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
export TMPDIR=$V/tmp
for tree in ref del; do
  out=$V/probe-keys/$tree
  mkdir -p "$out"
  cp "$V/probe/keys/p43a-keys-probe.browser.mjs" "$V/$tree/src/web/ui-migration/"
  ( cd "$V/$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" \
      npx playwright test ui-migration/p43a-keys-probe.browser.mjs --config ui-migration/p43a.config.mjs \
      --project webkit-light-desktop --project webkit-dark-desktop ) > "$out/run.txt" 2>&1
  echo "exit=$?" >> "$out/run.txt"
  rm -f "$V/$tree/src/web/ui-migration/p43a-keys-probe.browser.mjs"
  echo "== $tree"; grep -o 'KEYS-PROBE.*' "$out/run.txt"
done
