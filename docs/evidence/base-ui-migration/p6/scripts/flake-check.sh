#!/usr/bin/env bash
# flake-check.sh RUN: the delivered fixture cases that did not pass in formal round RUN on the delivery, repeated on the
# delivery and on the base with the same spec files (the delivery's), so a red that comes and goes on both trees is told
# from one P6 brings. Each case runs --repeat-each 10 in the projects it failed in, alone in a memory-capped scope with
# a raised OOM score and its own network namespace; logs and JSON reports land in v1/RUN/flake. The base's spec files
# are put back afterwards.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
V=$T/v1
R=$V/$RUN/flake
export TMPDIR=$V/tmp
mkdir -p "$R"
CASES=(
  "choices|multiple labels search, toggle, collapse, remove and clear|webkit-light-phone webkit-dark-phone"
  "toasts|entrance progress survives a modal transfer before its first 180ms completes|webkit-dark-desktop webkit-light-desktop"
)
for f in choices.browser.mjs toasts.browser.mjs toasts-promotion.browser.mjs; do cp $V/del/src/web/ui-migration/$f $V/base/src/web/ui-migration/$f; done
echo "base spec files now: $(git -C $V/base status --short -- src/web/ui-migration | tr '\n' ' ')"
for tree in del base; do
  for item in "${CASES[@]}"; do
    IFS='|' read -r config title projects <<< "$item"
    name=$tree-$config
    for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
    args=(); for p in $projects; do args+=(--project "$p"); done
    { echo "tree: $V/$tree"; echo "head: $(git -C $V/$tree rev-parse HEAD)"; echo "case: $config / $title / $projects x10"; echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
    ( cd $V/$tree/src/web && rm -rf .$config-results && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
        unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config ui-migration/$config.config.mjs "${args[@]}" -g "$title" --repeat-each 10 ) >> "$R/$name.txt" 2>&1
    echo "exit=$?" >> "$R/$name.txt"
    cp $V/$tree/src/web/.$config-results/report.json "$R/$name.report.json" 2>/dev/null
    echo "== $name: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$R/$name.txt" | tr -s ' ' | tr '\n' ' ')"
    grep -hoE "Received: .{0,80}|\+   \".{0,90}" "$R/$name.txt" | sort | uniq -c | head -5
  done
done
git -C $V/base checkout -q -- src/web/ui-migration
echo "base spec files restored: [$(git -C $V/base status --short -- src/web/ui-migration | tr '\n' ' ')]"
