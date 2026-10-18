#!/usr/bin/env bash
# Control for D7's container-cap wait: the Docker backend's CONTAINER_LIMIT mapping switched off (the 429 then
# reaches the manager as a transient failure, as before), the recovery pg spec run, the file restored on exit.
set -o pipefail
F=src/apiserver/src/managed-runners/docker-backend.ts
K=/mnt/data/tmp/34hXCW6iauoWaquGQj7DO/docker-backend.ts.keep
cp "$F" "$K" || exit 1
trap 'cp "$K" "$F" && echo "restored $F: $(sha256sum < "$F" | cut -c1-12)"' EXIT
echo "before: $(sha256sum < "$F" | cut -c1-12)"
python3 -I - "$F" <<'PY' || exit 1
import sys
p = sys.argv[1]
t = open(p, encoding="utf-8").read()
on = "error.code === 'CONTAINER_LIMIT') throw new ManagedInstanceLimit"
assert t.count(on) == 1, t.count(on)
open(p, "w", encoding="utf-8").write(t.replace(on, "error.code === 'CONTAINER_LIMIT, switched off for the control') throw new ManagedInstanceLimit"))
PY
git diff --stat -- "$F"
S=src/apiserver/src/managed-runners
systemd-run --scope --quiet -p MemoryMax=6G -- bash -c "echo 1000 > /proc/self/oom_score_adj && exec bash scripts/run-pg-spec.sh $S/managed-runner-recovery.pg.spec.ts"
