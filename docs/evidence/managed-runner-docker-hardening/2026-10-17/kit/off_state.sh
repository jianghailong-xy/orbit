#!/bin/sh
# D8: the state of the test host's deployment without managed runners, inside it (prints no secret):
#   docker exec d8-dind sh /kit/off_state.sh <label>
cd /work/orbit || exit 1
echo "== $1 at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo ".env sha256=$(sha256sum .env | cut -c1-64) mode=$(stat -c %a .env); managed runner lines: [$(grep -E '^[[:space:]]*(ORBIT_MANAGED_RUNNERS|COMPOSE_PROFILES)' .env | tr '\n' ' ')]"
echo "under data/: $(ls -A data | tr '\n' ' ')"
echo "compose services: $(docker compose config --services | sort | tr '\n' ' ')"
echo "-- containers (name, image, created)"; docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.CreatedAt}}' | sort
echo "-- volumes"; for v in $(docker volume ls -q); do echo "$v used by [$(docker ps -a --filter volume=$v --format '{{.Names}}' | tr '\n' ' ')]"; done
echo "-- networks"; docker network ls --format '{{.Name}}' | sort | tr '\n' ' '; echo
echo "-- images"; docker image ls --format '{{.Repository}}:{{.Tag}}' | sort | tr '\n' ' '; echo
echo "-- anything of managed runners: containers [$(docker ps -aq --filter label=orbit.managed-runner.instance | wc -l)], volumes [$(docker volume ls -q --filter label=orbit.managed-runner.instance | wc -l)], docker-channel [$(docker ps -aq --filter name=orbit-docker-channel | wc -l)], network orbit-managed-runners [$(docker network ls -q --filter name=orbit-managed-runners | wc -l)]"
