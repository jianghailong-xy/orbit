#!/bin/bash
# Which container log files Alloy ships to Loki (docs/self-hosting.md, "Logs"), as a file_sd list Alloy's discovery.file
# reads: one entry per container of this Compose project, never one of a managed runner's.
#
# Alloy is given no Docker socket, so nothing here asks Docker. It reads each container's own record,
# /var/lib/docker/containers/<id>/config.v2.json, from the directory mounted read-only, and keeps a container only when
# Compose's label names this project; one that carries any orbit.managed-runner.* label, which the Docker channel puts on
# every runner it makes (deploy/managed-runner/docker-channel/channel.py), is left out whatever else it carries. Alloy
# therefore never opens a runner's log file, nor another project's on the same host.
#
#   log-targets.sh PROJECT OUT [SECONDS]   writes OUT again every SECONDS (5), by rename, so Alloy never reads half of it
set -u

project=$1 out=$2 every=${3:-5}
containers=/var/lib/docker/containers

targets() {
  local sep='' cfg dir id service name
  printf '['
  for cfg in "$containers"/*/config.v2.json; do
    [ -r "$cfg" ] || continue
    grep -qF "\"com.docker.compose.project\":\"$project\"" "$cfg" || continue
    grep -qE '"orbit\.managed-runner\.[a-z-]+":' "$cfg" && continue
    dir=${cfg%/config.v2.json}
    id=${dir##*/}
    service=$(grep -oE '"com\.docker\.compose\.service":"[^"\\]+"' "$cfg" | head -n 1 | cut -d '"' -f 4)
    name=$(grep -oE '"Name":"/[^"\\]+"' "$cfg" | head -n 1 | cut -d '"' -f 4)
    [ -n "$service" ] || continue
    printf '%s{"targets":["localhost"],"labels":{"__path__":"%s/%s-json.log","service":"%s","container":"%s"}}' \
      "$sep" "$dir" "$id" "$service" "${name#/}"
    sep=,
  done
  printf ']\n'
}

while :; do
  targets > "$out.new" && mv -f "$out.new" "$out"
  sleep "$every"
done
