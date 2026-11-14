#!/usr/bin/env bash
# The server machine's code images, built on the HPC host's Docker (its build cache) from `git archive` of the lab's
# commit, then saved for `docker load` into the server machine. Run under the heavy lock and the memory gate.
set -euo pipefail
SHA=$(git -C /root/orbit rev-parse "$1^{commit}")
SRC=/mnt/data/tmp/34w2jFb/src-$SHA
rm -rf "$SRC"; mkdir -p "$SRC"
git -C /root/orbit archive "$SHA" | tar -x -C "$SRC"
cd "$SRC"
echo "==> $(date -Is) building orbit-apiserver:local at $SHA"
docker build -q --provenance=false -f src/apiserver/Dockerfile -t mrmh-apiserver:local .
echo "==> $(date -Is) building orbit-web at $SHA"
docker build -q --provenance=false -f src/web/Dockerfile --build-arg ORBIT_SOURCE_SHA="$SHA" -t mrmh-web:latest .
echo "==> $(date -Is) saving"
docker save mrmh-apiserver:local mrmh-web:latest -o /mnt/data/tmp/34w2jFb/server-images.tar
ls -la /mnt/data/tmp/34w2jFb/server-images.tar
cd /; rm -rf "$SRC"
echo "==> $(date -Is) done"
