# T07's lab window: names and paths, sourced by every step (bash). Nothing secret here.
export WT=/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40
export KIT=/mnt/data/tmp/t07-34ZtjU1Q/kit
export RUN=/mnt/data/tmp/t07-34ZtjU1Q/lab
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t07
export W="python3 -I $WT/scripts/managed-runner/lab/wake-lab.py"
export L="python3 -I $KIT/t07lab.py"
export SW="python3 -I $WT/scripts/managed-runner/lab/single-writer.py"
export TS="$WT/scripts/managed-runner/lab/test-server.sh"
# T06b's lab image (deploy/managed-runner/image at ebf54ab8d plus the lab CA layer), already in the guest; runner-go
# has not changed since.
export IMAGE=docker.io/library/orbit-managed-runner-lab@sha256:cdb090148c194e536fe86c22f1507b45f74f2aa6929df26f7360747604102312
# The web build of this checkout, served same-origin with /api passed to the test apiserver.
export WEB_PORT=5873
# The same, answering /api/auth/capabilities 404: a server from before the capability.
export WEB_MISSING_PORT=5874
# A long-lived helper as its own transient unit, outside the runner's cgroup, memory-capped, output to $RUN/logs.
unit() {  # unit NAME MEMORY COMMAND...
  local name=$1 mem=$2; shift 2
  mkdir -p "$RUN/logs"
  systemd-run --unit="$name" --collect --quiet -p MemoryMax="$mem" -p OOMScoreAdjust=900 \
    -p Environment="LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR" -p WorkingDirectory="$RUN" \
    -p StandardOutput=append:"$RUN/logs/$name.log" -p StandardError=append:"$RUN/logs/$name.log" "$@"
}
