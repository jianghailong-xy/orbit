#!/usr/bin/env bash
# fixture-specs.sh TREE RUN [CONFIG...]: the coexistence fixtures' Playwright configs (default: all six) on TREE, one
# after another, each in its own network namespace and a memory-capped scope with a raised OOM score (the runner is
# OOMPolicy=stop). Each config's log, JSON report and output directory land in runs/RUN/CONFIG. A config whose log
# ends with `exit=` is skipped, so a stopped chain resumes. Stops when / has under 2 GB.
set -u
TREE=${1:?tree}; RUN=${2:?run}; shift 2
CONFIGS=("$@"); [ ${#CONFIGS[@]} -gt 0 ] || CONFIGS=(foundation controls overlays choices toasts composer)
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
R=$T/runs/$RUN
export TMPDIR=$T/tmp
mkdir -p "$R" "$TMPDIR"
for config in "${CONFIGS[@]}"; do
  log=$R/$config.txt
  if [ -f "$log" ] && grep -q '^exit=' "$log"; then echo "== $config already done ($(grep '^exit=' "$log"))"; continue; fi
  avail=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$avail" -lt 2048 ]; then echo "== STOP: / has ${avail}M available"; exit 3; fi
  # Wait (up to 30 min) for 4.5 GB of available memory: a global OOM kill is not a test result.
  for i in $(seq 1 60); do [ "$(free -m | awk '/Mem:/{print $7}')" -ge 4608 ] && break; sleep 30; done
  out=$TREE/src/web/.$config-results
  rm -rf "$out"
  { echo "config: $config"; echo "tree: $TREE"; echo "head: $(git -C "$TREE" rev-parse HEAD)"; echo "uncommitted:"; git -C "$TREE" status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$log"
  echo "== $config $(date -u +%T)"
  ( cd "$TREE/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config "ui-migration/$config.config.mjs" ) >> "$log" 2>&1
  code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$log"
  rm -rf "$R/$config-out"; [ -d "$out" ] && cp -a "$out" "$R/$config-out"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^exit=" "$log"
done
echo "== done $(date -u +%T)"
