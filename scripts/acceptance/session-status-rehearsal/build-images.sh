#!/usr/bin/env bash
# Build the images of the T16 rehearsal stack (README.md beside this file), each from a `git archive` of one commit, so
# the checkout's working tree plays no part:
#   $PROJECT-apiserver:d1     the apiserver at D1_REF (deploy D1: migrations 1611/1612, code still on the word)
#   $PROJECT-apiserver:d2     the apiserver at D2_REF (deploy D2: every reader on the facts, writers write both)
#   $PROJECT-link-gateway:local   from D2_REF (what the walk's stack serves beside them)
#   $PROJECT-web:latest           WEB_IMAGE retagged: the web image's runner-binary step needs a git checkout, which a
#                                 `git archive` is not, and the walk reads no page (it drives the API and the runner)
# usage: build-images.sh <work dir>     env: PROJECT (orbit-link-t16), D1_REF, D2_REF (default HEAD), WEB_IMAGE
#
# SIDES="<side>=<ref> ..." builds those sides instead of d1 and d2, each as $PROJECT-apiserver:<side>, and the link
# gateway from the last one (task T17, D3 to D4):
#   SIDES="d2=5a08c866c4 d3=feeb45cf16 d31=7474f16158 d4=HEAD" PROJECT=orbit-link-t17 WEB_IMAGE=... build-images.sh /mnt/tmp/t17
set -euo pipefail
WORK=${1:?work dir}
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
PROJECT=${PROJECT:-orbit-link-t16}
if [ -z "${SIDES:-}" ]; then
  D1_REF=${D1_REF:?D1_REF: the commit deploy D1 ships}
  SIDES="d1=$D1_REF d2=${D2_REF:-HEAD}"
fi
sides=()
for pair in $SIDES; do
  side=${pair%%=*}
  declare "$side=$(git -C "$REPO" rev-parse "${pair#*=}^{commit}")"
  sides+=("$side")
done
last=${sides[${#sides[@]}-1]}
for side in "${sides[@]}"; do
  sha=${!side}
  rm -rf "$WORK/src-$side"; mkdir -p "$WORK/src-$side"
  git -C "$REPO" archive "$sha" | tar -x -C "$WORK/src-$side"
  echo "== $(date -u +%FT%TZ) apiserver $side from $sha"
  t0=$(date +%s)
  docker build -q -f "$WORK/src-$side/src/apiserver/Dockerfile" -t "$PROJECT-apiserver:$side" \
    --label "t16.source=$sha" "$WORK/src-$side"
  echo "   built $PROJECT-apiserver:$side in $(( $(date +%s) - t0 )) s: $(docker image inspect -f '{{.Id}}' "$PROJECT-apiserver:$side")"
done
echo "== $(date -u +%FT%TZ) link gateway from ${!last}; web is ${WEB_IMAGE:?WEB_IMAGE: an existing web image to retag}"
docker tag "$WEB_IMAGE" "$PROJECT-web:latest"
docker build -q --build-arg "ORBIT_SOURCE_SHA=${!last}" -t "$PROJECT-link-gateway:local" "$WORK/src-$last/src/link-gateway"
for side in "${sides[@]}"; do echo "${!side}" > "$WORK/$side.sha"; done
echo "== $(date -u +%FT%TZ) done"
