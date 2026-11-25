#!/usr/bin/env bash
# Stop what the walk started, by the pid files it wrote, and remove only its own postgres container.
# usage: down.sh <walk dir>
set -u
walk=$1
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null && echo "stopped $pid"
}
for f in beat.pid preview.pid api.pid; do
  [ -f "$walk/$f" ] && kill_tree "$(cat "$walk/$f")" && rm -f "$walk/$f"
done
if [ -f "$walk/pg.name" ]; then
  docker rm -f "$(cat "$walk/pg.name")" >/dev/null && echo "removed container $(cat "$walk/pg.name")"
  rm -f "$walk/pg.name"
fi
