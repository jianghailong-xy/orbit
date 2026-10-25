#!/usr/bin/env bash
# step.sh NAME TREE CMD...: one run of this task's checks, logged to /mnt/data/tmp/34dq7m9wxKsEaWbvtNqk2/runs/NAME.txt
# (argv, tree and HEAD, uncommitted paths, load, memory, disk, the run, its exit). Resumable: a log ending in its exit
# code is skipped. Stops with exit 3 when / has under 2 GB, and waits for 3 GB available memory. Own systemd scope
# (MemoryMax=6G, oom_score_adj 500) and own network namespace, run from TREE/src/web. MOVE_RESULTS names a results
# directory inside TREE (relative) to move to $R/NAME-out afterwards. Adapted from
# multiselect-ro-loop/scripts/step.sh (same host discipline as the P2/RO tasks).
set -u
V=/mnt/data/tmp/34dq7m9wxKsEaWbvtNqk2
R=$V/runs
name=$1 tree=$2; shift 2
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
log=$R/$name.txt
if [ -f "$log" ] && grep -q '^exit=' "$log"; then echo "== $name already done ($(grep '^exit=' "$log"))"; exit 0; fi
avail=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
if [ "$avail" -lt 2048 ]; then echo "== STOP: / has ${avail}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
while [ "$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)" -lt 3072 ]; do sleep 30; done
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
    'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$log" 2>&1
code=$?
if [ -n "${MOVE_RESULTS:-}" ] && [ -e "$tree/$MOVE_RESULTS" ]; then mv "$tree/$MOVE_RESULTS" "$R/$name-out"; fi
{ echo "end: $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg)"; echo "exit=$code"; } >> "$log"
tail -n 12 "$log"
exit $code
