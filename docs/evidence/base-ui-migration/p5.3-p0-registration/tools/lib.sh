# Shared by the queue scripts of this registration (34dTUdzY6mgNk4CGh7ZHl). Every browser run goes through
# step(): it waits for memory (MemAvailable >= 3.5 GB, up to 30 min), checks the root disk (stop below 6 GB, the
# project's floor for runs that write to /), and runs the command alone in a 6 GB memory-capped systemd scope with
# oom_score_adj 500 (the runner is OOMPolicy=stop). TMPDIR is on /mnt/data.
B=/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl
WT=/root/.orbit/worktrees/987049ab-c5e9-5a28-9ec0-0e4db66893c8
EV=$WT/docs/evidence/base-ui-migration
TOOLS32=$EV/p3.2-accepted/tools
NETNS=$EV/p0-drift-2/tools/netns-regression.sh
R=$B/runs
export TMPDIR=$B/tmp
mkdir -p "$R" "$TMPDIR"
avail_mb() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
root_mb() { df --output=avail -BM / | tail -1 | tr -dc '0-9'; }
gate() {
  local i
  for i in $(seq 1 180); do
    [ "$(avail_mb)" -ge 3500 ] && break
    [ "$i" = 1 ] && echo "== waiting for memory: $(avail_mb) MB available $(date -u +%T)"
    sleep 10
  done
  if [ "$(root_mb)" -lt 6144 ]; then echo "== STOP: / has $(root_mb) MB available (< 6 GB) $(date -u +%T)"; exit 3; fi
  echo "== gate: $(avail_mb) MB available, / $(root_mb) MB, load $(cut -d' ' -f1-3 /proc/loadavg) $(date -u +%T)"
}
capped() { systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh "$@"; }
