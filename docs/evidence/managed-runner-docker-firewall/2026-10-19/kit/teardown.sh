#!/bin/bash
# Inside the D9 test host: remove one scenario's deployment, its managed runners and their network, so that the next
# one is a fresh install on a host that never had one. The host's iptables rules go with the next restart of the test
# host (a new network namespace), which the scenarios do in between.
#   teardown.sh <dir under /work>
set -u
cd "/work/$1" 2>/dev/null && docker compose --profile managed-runners-docker --profile managed-runner-firewall down -v --remove-orphans
ids="$(docker ps -aq --filter label=orbit.managed-runner.instance)"; [ -z "$ids" ] || docker rm -f $ids
vols="$(docker volume ls -q --filter label=orbit.managed-runner.instance)"; [ -z "$vols" ] || docker volume rm $vols
docker network rm orbit-managed-runners 2>/dev/null
docker volume prune -f >/dev/null
rm -rf "/work/$1"
echo "left: $(docker ps -aq | wc -l) containers, $(docker volume ls -q | wc -l) volumes, networks: $(docker network ls --format '{{.Name}}' | tr '\n' ' ')"
