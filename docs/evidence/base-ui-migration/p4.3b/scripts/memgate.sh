# memgate.sh (sourced by the chain's scripts): memgate waits before a heavy step until MemAvailable is at
# least MEMGATE_MB (3072 by default). The coordinator's rule of 2026-10-09: the 08:30Z runner stop was the kernel OOM
# killing a chrome in the runner's service (OOMPolicy=stop); the host has 14 GB beside vLLM and postgres.
memgate() {
  local need=${MEMGATE_MB:-3072} avail waited=0
  while :; do
    avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
    [ "$avail" -ge "$need" ] && break
    [ $((waited % 300)) -eq 0 ] && echo "== memgate: MemAvailable ${avail}M < ${need}M, waiting ($(date -u +%T))"
    sleep 30; waited=$((waited + 30))
  done
  [ "$waited" -gt 0 ] && echo "== memgate: MemAvailable ${avail}M after ${waited}s ($(date -u +%T))"
  return 0
}
memline() { awk '/^MemAvailable:/ {a = int($2 / 1024)} /^SwapFree:/ {s = int($2 / 1024)} END {print "mem: " a "M available, swap " s "M free"}' /proc/meminfo; }
# scoped CMD...: CMD in its own transient systemd scope (MemoryMax=6G, oom_score_adj 500), so an OOM kill takes the test
# and not the runner, whose unit is OOMPolicy=stop (the coordinator's rule of 2026-10-09). The first line it prints
# names the cgroup it runs in (run-*.scope, not orbit-runner-root.service), on stderr so a command's own output stays
# clean. Its exit code is CMD's.
scoped() {
  systemd-run --scope --quiet -p MemoryMax=6G sh -c \
    'echo 500 > /proc/self/oom_score_adj && echo "cgroup: $(cat /proc/self/cgroup) oom_score_adj $(cat /proc/self/oom_score_adj)" >&2 && exec "$@"' sh "$@"
}
