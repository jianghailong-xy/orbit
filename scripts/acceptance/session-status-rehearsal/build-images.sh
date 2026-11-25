#!/usr/bin/env bash
# Build the images of the T16 rehearsal stack (README.md beside this file), each from a `git archive` of one commit, so
# the checkout's working tree plays no part:
#   $PROJECT-apiserver:d1     the apiserver at D1_REF (deploy D1: migrations 1611/1612, code still on the word)
#   $PROJECT-apiserver:d2     the apiserver at D2_REF (deploy D2: every reader on the facts, writers write both)
#   $PROJECT-link-gateway:local   from D2_REF (what the walk's stack serves beside them)
#   $PROJECT-web:latest           WEB_IMAGE retagged: the web image's runner-binary step needs a git checkout, which a
#                                 `git archive` is not, and the walk reads no page (it drives the API and the runner)
# usage: build-images.sh <work dir>     env: PROJECT (orbit-link-t16), D1_REF, D2_REF (default HEAD), WEB_IMAGE
set -euo pipefail
WORK=${1:?work dir}
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PROJECT=${PROJECT:-orbit-link-t16}
D1_REF=${D1_REF:?D1_REF: the commit deploy D1 ships}
D2_REF=${D2_REF:-HEAD}
d1=$(git -C "$REPO" rev-parse "$D1_REF^{commit}"); d2=$(git -C "$REPO" rev-parse "$D2_REF^{commit}")
for side in d1 d2; do
  sha=${!side}
  rm -rf "$WORK/src-$side"; mkdir -p "$WORK/src-$side"
  git -C "$REPO" archive "$sha" | tar -x -C "$WORK/src-$side"
  echo "== $(date -u +%FT%TZ) apiserver $side from $sha"
  t0=$(date +%s)
  docker build -q -f "$WORK/src-$side/src/apiserver/Dockerfile" -t "$PROJECT-apiserver:$side" \
    --label "t16.source=$sha" "$WORK/src-$side"
  echo "   built $PROJECT-apiserver:$side in $(( $(date +%s) - t0 )) s: $(docker image inspect -f '{{.Id}}' "$PROJECT-apiserver:$side")"
done
echo "== $(date -u +%FT%TZ) link gateway from $d2; web is ${WEB_IMAGE:?WEB_IMAGE: an existing web image to retag}"
docker tag "$WEB_IMAGE" "$PROJECT-web:latest"
docker build -q --build-arg "ORBIT_SOURCE_SHA=$d2" -t "$PROJECT-link-gateway:local" "$WORK/src-d2/src/link-gateway"
echo "$d1" > "$WORK/d1.sha"; echo "$d2" > "$WORK/d2.sha"
echo "== $(date -u +%FT%TZ) done"
