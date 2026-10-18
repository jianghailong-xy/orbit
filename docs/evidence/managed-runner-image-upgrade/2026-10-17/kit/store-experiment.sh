#!/bin/sh
# What a Docker image store does with an image whose tag moved to a newer build while a container still runs
# it: the managed runner image's case after /upgrade. Run inside a throwaway dind; prints each step.
set -e
echo "== store: $(docker info --format '{{.Driver}} {{json .DriverStatus}}')"
mkdir -p /x && cd /x
printf 'FROM alpine:3\nARG V\nRUN echo "$V" > /v\nCMD ["sleep", "3600"]\n' > Dockerfile
docker build -q --provenance=false --build-arg V=previous -t t:local . >/dev/null
A="$(docker image inspect -f '{{.Id}}' t:local)"; echo "previous image $A"
docker run -d --name runner t:local >/dev/null
docker build -q --provenance=false --build-arg V=new -t t:local . >/dev/null
B="$(docker image inspect -f '{{.Id}}' t:local)"; echo "new image $B (the tag moved)"
echo "-- images"; docker image ls --all --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'
echo "-- the container: $(docker inspect runner --format '{{.Image}} {{.State.Status}}')"
echo "-- docker ps -a --filter ancestor=<previous>"; docker ps -a --filter "ancestor=$A" --format '{{.Names}} {{.Image}}' 2>&1 || true
echo "-- docker image rm <previous>"; docker image rm "$A" 2>&1 || true
echo "-- docker image prune -f, the container still there"; docker image prune -f 2>&1
docker image ls --all --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'
docker stop -t 1 runner >/dev/null; docker rm runner >/dev/null; echo "-- the container stopped and removed"
echo "-- docker image prune -f"; docker image prune -f 2>&1
docker image ls --all --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'
echo "-- can a container still be made from the previous image?"; docker create --name again "$A" 2>&1 | tail -1 || true
