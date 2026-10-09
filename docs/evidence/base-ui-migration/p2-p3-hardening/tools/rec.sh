#!/usr/bin/env bash
# rec.sh <label> <command string> — P3.3's run recorder (p33/tools/rec.sh), with the runs directory fixed
# to this evidence directory. Runs the command with bash -c at the repository root and records under
# runs/<label>/:
#   meta.txt    HEAD, branch, porcelain status, command, UTC start/end, load average, exit code
#   output.txt  full stdout+stderr
# Refuses to reuse a label. Exit status is the command's.
set -u
label=$1; shift
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
d=$here/runs/$label
if [ -e "$d" ]; then echo "refuse: $d exists"; exit 2; fi
mkdir -p "$d"
cd "$root" || exit 2
{
  echo "label=$label"
  echo "head=$(git rev-parse HEAD)"
  echo "branch=$(git branch --show-current)"
  echo "status_begin"; git status --porcelain=v1 --untracked-files=normal -- . ":(exclude)${d#$root/}" | sed 's/^/  /'; echo "status_end"
  echo "command=$*"
  echo "start=$(date -u +%FT%TZ)"
  echo "load_start=$(cut -d' ' -f1-3 /proc/loadavg)"
} > "$d/meta.txt"
bash -c "$*" > "$d/output.txt" 2>&1
rc=$?
{ echo "end=$(date -u +%FT%TZ)"; echo "load_end=$(cut -d' ' -f1-3 /proc/loadavg)"; echo "exit=$rc"; } >> "$d/meta.txt"
echo "[$label] exit=$rc"
tail -8 "$d/output.txt"
exit $rc
