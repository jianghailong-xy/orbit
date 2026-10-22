# T07's Docker phase: names and paths, sourced by every step (bash). Nothing secret here.
export WT=/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40
export KIT=/mnt/data/tmp/t07-34ZtjU1Q/kit
export RUN=/mnt/data/tmp/t07-34ZtjU1Q/dock
export LAB_TEST_SERVER_DIR=/mnt/data/tmp/t07-34ZtjU1Q/docker
export D="python3 -I $KIT/t07docker.py"
export API_PORT=13730
export WEB_PORT=5875
unit() {  # unit NAME MEMORY COMMAND...
  local name=$1 mem=$2; shift 2
  mkdir -p "$RUN/logs"
  systemd-run --unit="$name" --collect --quiet -p MemoryMax="$mem" -p OOMScoreAdjust=900 \
    -p Environment="LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR" -p Environment="T07_API_PORT=$API_PORT" -p WorkingDirectory="$RUN" \
    -p StandardOutput=append:"$RUN/logs/$name.log" -p StandardError=append:"$RUN/logs/$name.log" "$@"
}
