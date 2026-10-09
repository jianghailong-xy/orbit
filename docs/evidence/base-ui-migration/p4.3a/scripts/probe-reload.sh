#!/usr/bin/env bash
# probe-reload.sh: the reload probe (probe/reload/p43a-reload-probe.browser.mjs) on each tree of round 5, WebKit light
# and dark desktop, each tree in its own network namespace; the probe file is copied into the tree for the run and
# removed after. Results under v1/probe-reload/<tree>. Resumable.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
export TMPDIR=$V/tmp
for tree in ref del; do
  out=$V/probe-reload/$tree
  [ -f "$out/done" ] && continue
  mkdir -p "$out"
  cp "$V/probe/reload/p43a-reload-probe.browser.mjs" "$V/$tree/src/web/ui-migration/"
  { echo "tree: $tree $(git -C "$V/$tree" rev-parse HEAD)"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; } > "$out/run.txt"
  ( cd "$V/$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env P43A_SNAPSHOTS="$out/shots" P43A_OUTPUT="$out/out" \
      npx playwright test ui-migration/p43a-reload-probe.browser.mjs --config ui-migration/p43a.config.mjs \
      --project webkit-light-desktop --project webkit-dark-desktop ) >> "$out/run.txt" 2>&1
  echo "exit=$?" >> "$out/run.txt"
  rm -f "$V/$tree/src/web/ui-migration/p43a-reload-probe.browser.mjs"
  touch "$out/done"
  echo "== $tree: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
  grep -ho "[^\"]*due to access control checks[^\"]*" "$out"/out/*/evidence.json 2>/dev/null | sort | uniq -c
done
