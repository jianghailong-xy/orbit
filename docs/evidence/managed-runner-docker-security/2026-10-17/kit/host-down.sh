#!/bin/bash
# D5 (task 34hJ7S9C3isVnzIDDfSHD): remove what host-up.sh and host_runner.py made on the HPC host's Docker, through the
# channel where the channel made it (stop, remove by UID, drop the credential and the volume by UID), then the channel,
# its network, the target container on the default bridge and the two images it tagged. Prints what is left labelled.
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE=/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/host/runners.json
if [ -f "$STATE" ] && docker inspect d5-host-channel >/dev/null 2>&1; then
  for key in $(python3 -c "import json; print(' '.join(json.load(open('$STATE'))))"); do
    python3 -I "$KIT/host_runner.py" stop "$key" >/dev/null
    for _ in $(seq 1 30); do
      [ "$(docker inspect -f '{{.State.Running}}' "$(python3 -c "import json; print(json.load(open('$STATE'))['$key']['name'])")" 2>/dev/null)" = true ] || break
      sleep 1
    done
    python3 -I "$KIT/host_runner.py" remove "$key" >/dev/null
    python3 -I "$KIT/host_runner.py" forget "$key" >/dev/null
  done
fi
docker rm -f d5-other-net d5-host-channel >/dev/null 2>&1
docker network rm orbit-mr-d5 >/dev/null 2>&1
docker image rm orbit-docker-channel:d5-34hJ7S9C3isVnzIDDfSHD orbit-managed-runner:d5-34hJ7S9C3isVnzIDDfSHD >/dev/null 2>&1
echo "left with the test label:"
docker ps -a --filter label=orbit.test=d5-34hJ7S9C3isVnzIDDfSHD --format '  container {{.Names}} {{.Status}}'
docker volume ls --filter label=orbit.test=d5-34hJ7S9C3isVnzIDDfSHD --format '  volume {{.Name}}'
docker network ls --filter label=orbit.test=d5-34hJ7S9C3isVnzIDDfSHD --format '  network {{.Name}}'
docker images --format '  image {{.Repository}}:{{.Tag}}' | grep -- '-34hJ7S9C3isVnzIDDfSHD' || true
