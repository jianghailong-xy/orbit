# Sourced by the queue scripts. done_or_clear <dir> <marker>: true when <dir>/<marker> exists; a <dir> without it is
# what an interrupted run left behind, so it moves to the scratch trash and the step runs again.
done_or_clear() {
  [ -e "$1/$2" ] && return 0
  if [ -e "$1" ]; then mkdir -p /mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trash/partial; mv "$1" "/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trash/partial/$(basename "$1").$(date +%s)"; fi
  return 1
}
step() { echo "== $(date -u +%FT%TZ) $*"; }
