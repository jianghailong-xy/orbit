#!/usr/bin/env bash
# resident.sh TREE LABEL [extra playwright args...]: the resident spec (src/web/ui-migration/tasks-toolbar.browser.mjs and
# its config, from the session worktree) on one tree's production build, in its own network namespace and memory-capped
# scope. On a tree that does not carry the spec (the unfixed tip, the project line before P4.3a) the spec, its config
# and the P4.3a fixtures are copied in for the run and removed after. Output under runs/resident-LABEL.
set -u
WT=/root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
export TMPDIR=$T/tmp
tree=$1; label=$2; shift 2
out=$T/runs/resident-$label
mkdir -p "$out"
ui=$T/$tree/src/web/ui-migration
added=()
for f in tasks-toolbar.browser.mjs tasks-toolbar.config.mjs p43a-fixtures.mjs; do
  [ -f "$ui/$f" ] || { cp "$WT/src/web/ui-migration/$f" "$ui/"; added+=("$ui/$f"); }
done
{ echo "tree: $tree $(git -C "$T/$tree" rev-parse HEAD) changed: $(git -C "$T/$tree" status --porcelain | tr '\n' ' ')"; echo "spec: $(sha256sum "$ui/tasks-toolbar.browser.mjs" | cut -c1-16) runs: ${TASKS_TOOLBAR_RUNS:-4}"; echo "load: $(cat /proc/loadavg)"; echo "root: $(df -BM --output=avail / | tail -1)"; echo "started: $(date -u +%FT%TZ)"; } > "$out/run.txt"
( cd "$T/$tree/src/web" && "$T/scripts/scoped.sh" nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash env TASKS_TOOLBAR_OUTPUT="$out/out" TASKS_TOOLBAR_RUNS="${TASKS_TOOLBAR_RUNS:-4}" \
    npx playwright test --config ui-migration/tasks-toolbar.config.mjs "$@" ) >> "$out/run.txt" 2>&1
echo "exit=$?" >> "$out/run.txt"; echo "ended: $(date -u +%FT%TZ) load: $(cat /proc/loadavg)" >> "$out/run.txt"
rm -f "${added[@]}"
echo "== $label: $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$out/run.txt" | tr -s ' ' | tr '\n' ' ')"
