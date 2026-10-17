#!/usr/bin/env bash
# step.sh NAME TREE CMD...: one run, logged to $V/runs/NAME.txt with its argv, tree, HEAD, uncommitted paths, load, memory,
# disk and exit code. Resumable: a log that ends with its exit code is skipped; one without runs again from empty
# outputs. Before it starts: / below 2 GB (df -BM) stops with exit 3 for a report, and it waits for 3 GB of available
# memory. It runs in its own systemd scope (MemoryMax=6G, oom_score_adj 500: an OOM kill takes the run, not the
# runner, whose unit is OOMPolicy=stop) and its own network namespace (fixed ports stay private, and Chromium does not
# see other sessions' interface churn), from TREE/src/web, with TMPDIR on /mnt/data.
set -u
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
name=$1 tree=$2; shift 2
R=$V/runs
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
log=$R/$name.txt
if [ -f "$log" ] && grep -q '^exit=' "$log"; then echo "== $name already done ($(grep '^exit=' "$log"))"; exit 0; fi
avail=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
if [ "$avail" -lt 2048 ]; then echo "== STOP: / has ${avail}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
waited=0
while [ "$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)" -lt 3072 ]; do
  [ $((waited % 300)) -eq 0 ] && echo "== $name: waiting for 3 GB available memory ($(date -u +%T))"
  sleep 30; waited=$((waited + 30))
done
rm -rf "$R/$name-out"
{
  echo "argv: $*"
  echo "tree: $tree HEAD $(git -C "$tree" rev-parse HEAD)"
  echo "uncommitted: $(git -C "$tree" status --porcelain --untracked-files=no | tr '\n' ' ')"
  echo "start: $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)"
  awk '/^MemAvailable:/ {a = int($2 / 1024)} /^SwapFree:/ {s = int($2 / 1024)} END {print "mem: " a "M available, swap " s "M free"}' /proc/meminfo
  echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available"
} > "$log"
( cd "$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c \
    'echo 500 > /proc/self/oom_score_adj && echo "cgroup: $(cat /proc/self/cgroup)" >&2 && exec "$@"' sh \
    unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$log" 2>&1
code=$?
# A config that writes its results inside the tree (the P2 keyboard-window ones): MOVE_RESULTS names that directory,
# relative to TREE, and it is moved to $R/NAME-out so the next run does not overwrite it.
if [ -n "${MOVE_RESULTS:-}" ] && [ -e "$tree/$MOVE_RESULTS" ]; then mv "$tree/$MOVE_RESULTS" "$R/$name-out"; fi
{ echo "end: $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)"; echo "exit=$code"; } >> "$log"
tail -n 12 "$log"
exit $code
