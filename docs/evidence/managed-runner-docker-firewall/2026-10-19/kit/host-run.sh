#!/bin/bash
# On the HPC host: run a command inside the D9 test host, detached, so that it outlives this shell and the session that
# started it. Its output goes to /evidence/<name>.log and its exit status to /evidence/<name>.exit (both under
# /mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/evidence on the HPC host).
#   host-run.sh <name> <workdir in the test host> <command...>
#   host-run.sh --wait <name> [seconds]     wait for it (up to seconds, default 580), then print its exit status
set -euo pipefail
E=/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR/evidence
if [ "$1" = --wait ]; then
  name="$2"; limit="${3:-580}"; end=$((SECONDS + limit))
  until [ -e "$E/$name.exit" ]; do
    [ $SECONDS -lt $end ] || { echo "still running: $name ($(wc -l <"$E/$name.log") lines)"; tail -n 3 "$E/$name.log"; exit 3; }
    sleep 5
  done
  echo "$name exited $(cat "$E/$name.exit")"; tail -n 5 "$E/$name.log"; exit 0
fi
name="$1"; dir="$2"; shift 2
mkdir -p "$(dirname "$E/$name")"
rm -f "$E/$name.exit" "$E/$name.log"
cmd="$(printf '%q ' "$@")"
docker exec -d -w "$dir" d9-dind sh -c "{ echo \"+ \$(date -u +%FT%TZ) in $dir: $cmd\"; $cmd; } >/evidence/$name.log 2>&1; echo \$? >/evidence/$name.exit"
echo "started $name"
