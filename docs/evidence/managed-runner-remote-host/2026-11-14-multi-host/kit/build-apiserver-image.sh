#!/usr/bin/env bash
# The server machine's apiserver image alone, rebuilt on the HPC host's Docker from `git archive` of a later commit (the
# web image is unchanged), saved, loaded into the server machine and tagged as the stack's. Run under the heavy lock.
set -euo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
SHA=$(git -C /root/orbit rev-parse "$1^{commit}")
SRC=$K/src-$SHA
rm -rf "$SRC"; mkdir -p "$SRC"
git -C /root/orbit archive "$SHA" | tar -x -C "$SRC"
cd "$SRC"
echo "==> $(date -Is) building orbit-apiserver:local at $SHA"
docker build -q --provenance=false -f src/apiserver/Dockerfile -t mrmh-apiserver:fix .
docker save mrmh-apiserver:fix -o $K/apiserver-fix.tar
cd /; rm -rf "$SRC"
docker exec -i "$SERVER" docker load -q < $K/apiserver-fix.tar
docker exec "$SERVER" docker tag mrmh-apiserver:fix orbit-apiserver:local
docker exec "$SERVER" docker image inspect -f '{{.Id}}' orbit-apiserver:local
echo "==> $(date -Is) done"
