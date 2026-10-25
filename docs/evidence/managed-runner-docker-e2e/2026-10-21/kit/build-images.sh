#!/usr/bin/env bash
# The two local images the D4 stack runs, from a clean archive of the checkout's HEAD: the managed runner image
# (deploy/managed-runner/image, as scripts/install-server.sh builds it) and the restricted Docker channel
# (deploy/managed-runner/docker-channel, as root Compose builds it). Built in the memory-capped buildx builder
# t03-capped (docker-container driver, 5 GiB) and loaded into this host's Docker; nothing is pushed.
#   build-images.sh REPO WORKDIR
set -euo pipefail
REPO=${1:?usage: build-images.sh REPO WORKDIR}
W=${2:?usage: build-images.sh REPO WORKDIR}
SHA=$(git -C "$REPO" rev-parse HEAD)
[ -z "$(git -C "$REPO" status --porcelain -- deploy/managed-runner src/runner-go)" ] || { echo "uncommitted image sources" >&2; exit 1; }
rm -rf "$W/ctx" && mkdir -p "$W/ctx"
git -C "$REPO" archive HEAD | tar -x -C "$W/ctx"
echo "$SHA" > "$W/source-sha"
TAG=d4-${SHA:0:9}
started=$(date +%s)
docker buildx build --builder t03-capped --load --provenance=false \
  --file "$W/ctx/deploy/managed-runner/image/Dockerfile" --build-arg ORBIT_SOURCE_SHA="$SHA" \
  --tag "orbit-managed-runner:$TAG" "$W/ctx"
echo "runner image build: $(( $(date +%s) - started )) s"
started=$(date +%s)
docker buildx build --builder t03-capped --load --provenance=false \
  --file "$W/ctx/deploy/managed-runner/docker-channel/Dockerfile" \
  --tag "orbit-docker-channel:$TAG" "$W/ctx"
echo "channel image build: $(( $(date +%s) - started )) s"
for image in "orbit-managed-runner:$TAG" "orbit-docker-channel:$TAG"; do
  docker image inspect -f '{{index .RepoTags 0}} {{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}' "$image"
done
